import asyncio
from copy import deepcopy

import pytest
from fastapi import HTTPException

import server


def _matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(_matches(document, clause) for clause in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$exists" in expected and (key in document) != expected["$exists"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$in" in expected and actual not in expected["$in"]:
                return False
        elif actual != expected:
            return False
    return True


class FakeCollection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        found = next((document for document in self.documents if _matches(document, query)), None)
        return deepcopy(found) if found else None

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if _matches(document, query):
                self.documents.pop(index)
                return type("DeleteResult", (), {"deleted_count": 1})()
        return type("DeleteResult", (), {"deleted_count": 0})()

    async def find_one_and_update(self, query, update, **kwargs):
        for document in self.documents:
            if _matches(document, query):
                self._apply(document, update)
                return deepcopy(document)
        return None

    async def update_one(self, query, update):
        for document in self.documents:
            if _matches(document, query):
                self._apply(document, update)
                return type("UpdateResult", (), {"matched_count": 1})()
        return type("UpdateResult", (), {"matched_count": 0})()

    @staticmethod
    def _set_path(document, path, value):
        parts = path.split(".")
        target = document
        for part in parts[:-1]:
            target = target[int(part)] if isinstance(target, list) else target.setdefault(part, {})
        target[parts[-1]] = value

    @classmethod
    def _apply(cls, document, update):
        for path, value in update.get("$set", {}).items():
            cls._set_path(document, path, deepcopy(value))
        for path in update.get("$unset", {}):
            parts = path.split(".")
            target = document
            for part in parts[:-1]:
                target = target[int(part)] if isinstance(target, list) else target.get(part, {})
            target.pop(parts[-1], None)
        for path, value in update.get("$inc", {}).items():
            parts = path.split(".")
            target = document
            for part in parts[:-1]:
                target = target[int(part)] if isinstance(target, list) else target[part]
            target[parts[-1]] = target.get(parts[-1], 0) + value
        for path, value in update.get("$addToSet", {}).items():
            document.setdefault(path, [])
            if value not in document[path]:
                document[path].append(value)


class FakeDatabase:
    def __init__(self):
        self.collections = {
            "purchase_orders": FakeCollection([{
                "id": "po-1", "reference": "PO-1", "supplier_id": "supplier-1",
                "supplier_name": "Foam Supplier", "status": "ordered",
                "items": [{
                    "stock_id": "stock-1", "product": "Simple", "size": "910x100",
                    "quantity": 100, "received_quantity": 0, "unit_price": 10,
                }],
            }]),
            "stock": FakeCollection([{
                "id": "stock-1", "product": "Simple", "size": "910x100",
            }]),
            "stock_movements": FakeCollection(),
            "grvs": FakeCollection(),
            "buyings": FakeCollection(),
            "audit_log": FakeCollection(),
        }

    def __getitem__(self, name):
        return self.collections[name]

    def __getattr__(self, name):
        try:
            return self.collections[name]
        except KeyError:
            raise AttributeError(name)


def _install_fake_grv_dependencies(monkeypatch, fake_db):
    class NoopStockLock:
        def __init__(self, ids):
            self.ids = ids

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    async def insert(collection, data):
        record = {**deepcopy(data), "id": f"{collection}-{len(fake_db[collection].documents) + 1}"}
        await fake_db[collection].insert_one(record)
        return record

    async def update_doc(collection, record_id, data):
        await fake_db[collection].update_one({"id": record_id}, {"$set": data})
        return await fake_db[collection].find_one({"id": record_id})

    async def post_movement(stock, movement_type, quantity, user, **kwargs):
        return await insert("stock_movements", {
            "stock_id": stock["id"], "product": stock["product"], "size": stock["size"],
            "type": movement_type, "quantity": quantity, "direction": kwargs.get("direction", 1),
            "dedupe_key": kwargs.get("dedupe_key"),
            "reference": kwargs.get("reference", ""),
            "user": user["email"], **kwargs.get("extra", {}),
        })

    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    monkeypatch.setattr(server, "next_ref", _next_grv_reference)


async def _no_audit(*args, **kwargs):
    return None


async def _next_grv_reference(*args, **kwargs):
    return "GRV-2026-0001"


def _grv(actual):
    return server.GRVIn(
        purchase_order_id="po-1",
        received_date="2026-10-29",
        received_by="Receiver",
        items=[server.GRVLineIn(
            stock_id="stock-1",
            purchase_order_item_index=0,
            actual_received_quantity=actual,
            accepted_quantity=actual,
        )],
    )


def test_partial_grvs_update_po_and_stock_once_without_creating_buyings(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {"email": "receiver@example.test", "name": "Receiver", "_active_company_id": "test-company"}

    async def scenario():
        first = await server.create_grv(_grv(40), user)
        first = await server.confirm_grv(first["id"], user)
        assert first["status"] == "partially_received"
        assert fake_db.purchase_orders.documents[0]["items"][0]["received_quantity"] == 40

        second = await server.create_grv(_grv(35), user)
        second = await server.confirm_grv(second["id"], user)
        assert second["status"] == "partially_received"
        assert fake_db.purchase_orders.documents[0]["items"][0]["received_quantity"] == 75
        assert len(fake_db.stock_movements.documents) == 2
        assert sum(item["quantity"] for item in fake_db.stock_movements.documents) == 75
        assert len({item["dedupe_key"] for item in fake_db.stock_movements.documents}) == 2
        assert all(item["batch_id"].startswith("grv:") for item in fake_db.stock_movements.documents)
        assert all(item["batch_quantity"] == item["quantity"] for item in fake_db.stock_movements.documents)
        assert fake_db.buyings.documents == []

        with pytest.raises(HTTPException) as duplicate:
            await server.confirm_grv(second["id"], user)
        assert duplicate.value.status_code == 409

    asyncio.run(scenario())


def test_worker_grv_delete_requires_supervisor_except_in_superiqfoam(monkeypatch):
    fake_db = FakeDatabase()
    fake_db.grvs.documents.extend([
        {"id": "other-company-grv", "grv_number": "GRV-OTHER", "status": "draft"},
        {"id": "manufacturing-grv", "grv_number": "GRV-MFG", "status": "draft"},
        {"id": "superiqfoam-grv", "grv_number": "GRV-SIQ", "status": "draft"},
        {"id": "confirmed-grv", "grv_number": "GRV-CONFIRMED", "status": "completed"},
    ])
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    authorized_passwords = []

    async def authenticate_supervisor(password, user, allow_skip=True):
        authorized_passwords.append((password, allow_skip))
        if password != "valid-supervisor-password":
            raise HTTPException(403, "Supervisor password is incorrect")
        return "supervisor-id", "Supervisor"

    monkeypatch.setattr(server, "authenticate_supervisor", authenticate_supervisor)
    worker = {
        "id": "worker", "email": "worker@example.test", "is_worker": True,
        "_active_role": "user", "_active_company_id": "another-company",
        "worker_allowed_sections": ["grv"],
    }

    async def scenario():
        with pytest.raises(HTTPException) as missing_password:
            await server.delete_grv("other-company-grv", server.GRVDeleteIn(), worker)
        assert missing_password.value.status_code == 428

        with pytest.raises(HTTPException) as invalid_password:
            await server.delete_grv(
                "other-company-grv",
                server.GRVDeleteIn(supervisor_password="wrong-password"),
                worker,
            )
        assert invalid_password.value.status_code == 403

        deleted = await server.delete_grv(
            "other-company-grv",
            server.GRVDeleteIn(supervisor_password="valid-supervisor-password"),
            worker,
        )
        assert deleted == {"ok": True, "deleted": True}
        assert await fake_db.grvs.find_one({"id": "other-company-grv"}) is None

        wholesaler_admin = {
            "id": "wholesaler-admin", "email": "admin@example.test",
            "role": "user", "_active_role": "admin",
            "_active_company_id": "iqfoam-manufactoring",
            "company_roles": {server.WHOLESALERS_COMPANY_ID: "admin"},
        }
        assert server.can_skip_supervisor_approval(wholesaler_admin)
        await server.delete_grv(
            "manufacturing-grv",
            server.GRVDeleteIn(supervisor_password="valid-supervisor-password"),
            wholesaler_admin,
        )

        superiqfoam_worker = {**worker, "_active_company_id": server.DEFAULT_COMPANY_ID}
        deleted_without_password = await server.delete_grv(
            "superiqfoam-grv", server.GRVDeleteIn(), superiqfoam_worker,
        )
        assert deleted_without_password == {"ok": True, "deleted": True}
        assert authorized_passwords == [
            ("wrong-password", False),
            ("valid-supervisor-password", False),
            ("valid-supervisor-password", False),
        ]

        with pytest.raises(HTTPException) as confirmed:
            await server.delete_grv(
                "confirmed-grv", server.GRVDeleteIn(), superiqfoam_worker,
            )
        assert confirmed.value.status_code == 409

    asyncio.run(scenario())
