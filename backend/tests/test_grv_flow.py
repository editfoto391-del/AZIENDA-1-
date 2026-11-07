import asyncio
import re
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
            if "$lt" in expected and (actual is None or actual >= expected["$lt"]):
                return False
            if "$regex" in expected:
                options = re.IGNORECASE if "i" in expected.get("$options", "") else 0
                if actual is None or not re.search(expected["$regex"], str(actual), options):
                    return False
        elif actual != expected:
            return False
    return True


class FakeCollection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]
        self.find_queries = []

    def find(self, query=None, projection=None):
        self.find_queries.append(deepcopy(query or {}))
        return FakeCursor([
            document for document in self.documents
            if _matches(document, query or {})
        ])

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

    async def update_many(self, query, update):
        matched = 0
        for document in self.documents:
            if _matches(document, query):
                self._apply(document, update)
                matched += 1
        return type("UpdateResult", (), {"matched_count": matched})()

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
            "prices": FakeCollection(),
            "audit_log": FakeCollection(),
        }

    def __getitem__(self, name):
        return self.collections[name]

    def __getattr__(self, name):
        try:
            return self.collections[name]
        except KeyError:
            raise AttributeError(name)


class FakeCursor:
    def __init__(self, documents):
        self.documents = iter(deepcopy(documents))

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.documents)
        except StopIteration:
            raise StopAsyncIteration


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
            "user": user["email"], "created_at": "2026-10-29T00:00:00+00:00",
            **kwargs.get("extra", {}),
        })

    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    monkeypatch.setattr(server, "next_ref", _next_grv_reference)

    async def listall(collection, *args, **kwargs):
        return deepcopy(fake_db[collection].documents)

    async def ensure_product_identification(stock, company_id):
        return {"stock_id": stock["id"], "company_id": company_id}

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "ensure_product_identification", ensure_product_identification)


async def _no_audit(*args, **kwargs):
    return None


async def _next_grv_reference(*args, **kwargs):
    return "GRV-2026-0001"


def _grv(actual, *, sale_price_zone_1=None, sale_price_zone_2=None):
    return server.GRVIn(
        purchase_order_id="po-1",
        received_date="2026-10-29",
        received_by="Receiver",
        items=[server.GRVLineIn(
            stock_id="stock-1",
            purchase_order_item_index=0,
            actual_received_quantity=actual,
            accepted_quantity=actual,
            sale_price_zone_1=sale_price_zone_1,
            sale_price_zone_2=sale_price_zone_2,
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
        stock = server.apply_stock_movements(
            deepcopy(fake_db.stock.documents[0]), fake_db.stock_movements.documents,
        )
        assert stock["current"] == 75
        assert fake_db.buyings.documents == []

        with pytest.raises(HTTPException) as duplicate:
            await server.confirm_grv(second["id"], user)
        assert duplicate.value.status_code == 409

    asyncio.run(scenario())


@pytest.mark.parametrize("initial_status", ["completed", "reversing"])
def test_grv_reversal_batches_stock_history_reads_and_retries_interrupted_reversals(
    monkeypatch, initial_status,
):
    fake_db = FakeDatabase()
    fake_db.stock.documents.append({
        "id": "stock-2", "product": "Simple", "size": "1200x100",
    })
    fake_db.grvs.documents.append({
        "id": "grv-1", "grv_number": "GRV-1", "status": initial_status,
        "items": [
            {"stock_id": "stock-1", "product": "Simple", "size": "910x100",
             "accepted_quantity": 3, "unit_cost": 4},
            {"stock_id": "stock-2", "product": "Simple", "size": "1200x100",
             "accepted_quantity": 2, "unit_cost": 5},
        ],
    })
    fake_db.stock_movements.documents.extend([
        {"id": "receipt-1", "stock_id": "stock-1", "type": "purchase",
         "direction": 1, "quantity": 10, "dedupe_key": "grv:grv-1:stock-1",
         "unit_cost": 4, "historical_cost_status": "verified", "batch_id": "receipt-1"},
        {"id": "invoice-1", "stock_id": "stock-1", "type": "invoice",
         "direction": -1, "quantity": 2},
        {"id": "receipt-2", "stock_id": "stock-2", "type": "purchase",
         "direction": 1, "quantity": 5, "dedupe_key": "grv:grv-1:stock-2",
         "unit_cost": 5, "historical_cost_status": "verified", "batch_id": "receipt-2"},
    ])
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "admin@example.test", "_active_role": "admin",
        "_active_company_id": "test-company",
    }

    async def scenario():
        result = await server.reverse_grv(
            "grv-1", server.ReasonIn(reason="Incorrect delivery"), user,
        )
        assert result["status"] == "cancelled"
        reversals = [
            movement for movement in fake_db.stock_movements.documents
            if movement.get("reverses_grv")
        ]
        assert {movement["stock_id"]: movement["quantity"] for movement in reversals} == {
            "stock-1": 3, "stock-2": 2,
        }
        assert len(fake_db.stock_movements.find_queries) == 2
        assert len(fake_db.stock_movements.documents) == 5

    asyncio.run(scenario())


@pytest.mark.parametrize("lock_at", [None, "expired"])
def test_stock_lock_recovers_abandoned_lease_and_releases_only_its_own_lock(monkeypatch, lock_at):
    fake_db = FakeDatabase()
    old_lock = {"id": "stock-1", "lock": True, "lock_token": "abandoned-owner"}
    if lock_at == "expired":
        old_lock["lock_at"] = server.datetime.now(server.timezone.utc) - server.timedelta(minutes=3)
    fake_db.stock.documents = [old_lock]
    monkeypatch.setattr(server, "db", fake_db)

    async def scenario():
        lock = server.StockLock(["stock-1"])
        async with lock:
            acquired = await fake_db.stock.find_one({"id": "stock-1"})
            assert acquired["lock"] is True
            assert acquired["lock_token"] == lock.token
            assert acquired["lock_at"] > server.datetime.now(server.timezone.utc) - server.timedelta(seconds=5)

        released = await fake_db.stock.find_one({"id": "stock-1"})
        assert "lock" not in released
        assert "lock_at" not in released
        assert "lock_token" not in released

        async with server.StockLock(["stock-1"]):
            await fake_db.stock.update_one(
                {"id": "stock-1"},
                {"$set": {"lock_token": "another-owner"}},
            )
        still_owned = await fake_db.stock.find_one({"id": "stock-1"})
        assert still_owned["lock"] is True
        assert still_owned["lock_token"] == "another-owner"

    asyncio.run(scenario())


def test_superiqfoam_grv_updates_both_price_zones_when_confirmed(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "name": "Owner",
        "_active_role": "owner", "_active_company_id": "superiqfoam",
    }

    async def scenario():
        company_token = server.active_company_id.set("superiqfoam")
        try:
            grv = await server.create_grv(
                _grv(5, sale_price_zone_1=120, sale_price_zone_2=135), user,
            )
            assert fake_db.prices.documents == []

            confirmed = await server.confirm_grv(grv["id"], user)
            assert confirmed["items"][0]["sale_price_zone_1"] == 120
            assert confirmed["items"][0]["sale_price_zone_2"] == 135
            assert {
                (price["zone"], price["category"], price["size"], price["price"])
                for price in fake_db.prices.documents
            } == {
                (1, "Standard", "910x100", 120),
                (2, "Standard", "910x100", 135),
            }
            assert all(price["active"] and price["confirmed"] for price in fake_db.prices.documents)
            assert (await server.resolve_price(1, "Simple", "910x100"))["price"] == 120
            assert (await server.resolve_price(2, "Simple", "910x100"))["price"] == 135

            await server._apply_grv_sale_prices([{
                "zone": 1, "category": "Standard", "size": "910x100", "price": 125,
            }], user, confirmed)
            assert len(fake_db.prices.documents) == 2
            assert await server.resolve_price(1, "Simple", "910x100") == {
                "found": True, "price": 125,
            }
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


@pytest.mark.parametrize("company_id", ["iqfoam-manufactoring", "iqfoam-whole-sallers"])
def test_unified_price_companies_use_one_grv_sale_price(monkeypatch, company_id):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": company_id,
    }

    async def scenario():
        company_token = server.active_company_id.set(company_id)
        try:
            grv = await server.create_grv(_grv(5, sale_price_zone_1=120), user)
            await server.confirm_grv(grv["id"], user)
            assert len(fake_db.prices.documents) == 1
            assert fake_db.prices.documents[0]["zone"] == 1
            assert fake_db.prices.documents[0]["price"] == 120
            assert (await server.resolve_price(1, "Simple", "910x100"))["price"] == 120
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_grv_rejects_zone_two_price_for_other_companies_before_receipt(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": "iqfoam-manufactoring",
    }

    async def scenario():
        company_token = server.active_company_id.set("iqfoam-manufactoring")
        try:
            grv = await server.create_grv(
                _grv(5, sale_price_zone_2=135), user,
            )
            with pytest.raises(HTTPException) as invalid_zone:
                await server.confirm_grv(grv["id"], user)
            assert invalid_zone.value.status_code == 400
            assert fake_db.stock_movements.documents == []
            assert fake_db.prices.documents == []
            assert (await fake_db.grvs.find_one({"id": grv["id"]}))["status"] == "draft"
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_grv_price_list_updates_require_existing_owner_access(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    admin = {
        "email": "admin@example.test", "_active_role": "admin",
        "_active_company_id": "superiqfoam",
    }

    async def scenario():
        company_token = server.active_company_id.set("superiqfoam")
        try:
            grv = await server.create_grv(_grv(5, sale_price_zone_1=120), admin)
            with pytest.raises(HTTPException) as unauthorized:
                await server.confirm_grv(grv["id"], admin)
            assert unauthorized.value.status_code == 403
            assert fake_db.stock_movements.documents == []
            assert fake_db.prices.documents == []
            assert (await fake_db.grvs.find_one({"id": grv["id"]}))["status"] == "draft"
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_worker_cannot_update_price_list_through_grv(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    worker = {
        "email": "worker@example.test", "is_worker": True,
        "_active_role": "user", "_active_company_id": "superiqfoam",
    }

    async def scenario():
        company_token = server.active_company_id.set("superiqfoam")
        try:
            grv = await server.create_grv(_grv(5, sale_price_zone_1=120), worker)
            with pytest.raises(HTTPException) as unauthorized:
                await server.confirm_grv(grv["id"], worker)
            assert unauthorized.value.status_code == 403
            assert fake_db.stock_movements.documents == []
            assert fake_db.prices.documents == []
            assert (await fake_db.grvs.find_one({"id": grv["id"]}))["status"] == "draft"
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_grv_creates_new_stock_product_catalog_identity_and_invoice_prices(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": "superiqfoam",
    }
    identity_calls = []

    async def ensure_identity(stock, company_id):
        identity_calls.append((stock["id"], company_id))
        stock["product_id"] = "IQF-NEW-PRODUCT"
        await fake_db.stock.update_one(
            {"id": stock["id"]}, {"$set": {"product_id": stock["product_id"]}},
        )
        return {"product_id": stock["product_id"]}

    monkeypatch.setattr(server, "ensure_product_identification", ensure_identity)

    async def scenario():
        company_token = server.active_company_id.set("superiqfoam")
        try:
            body = server.GRVIn(
                supplier_name="New Product Supplier",
                received_date="2026-10-29",
                received_by="Owner",
                items=[server.GRVLineIn(
                    new_product=True,
                    product="Premium Foam",
                    size="600x100",
                    actual_received_quantity=8,
                    accepted_quantity=8,
                    unit_cost=30,
                    sale_price_zone_1=60,
                    sale_price_zone_2=70,
                )],
            )
            grv = await server.create_grv(body, user)
            assert len(fake_db.stock.documents) == 1
            assert len(fake_db.prices.documents) == 0

            confirming_grv = {**grv, "status": "confirming"}
            await fake_db.grvs.update_one(
                {"id": grv["id"]}, {"$set": {"status": "confirming"}},
            )
            await server._materialize_grv_new_products(confirming_grv, user)
            await server._materialize_grv_new_products(confirming_grv, user)
            assert len(fake_db.stock.documents) == 2
            assert len(identity_calls) == 2
            stock_item = next(item for item in fake_db.stock.documents if item["product"] == "Premium Foam")
            assert stock_item["created_from_grv_id"] == grv["id"]
            assert stock_item["product_id"] == "IQF-NEW-PRODUCT"

            confirmed = await server.confirm_grv(grv["id"], user)
            assert confirmed["status"] == "completed"
            assert confirmed["items"][0]["stock_id"] == stock_item["id"]
            assert confirmed["items"][0]["product_code"] == "IQF-NEW-PRODUCT"
            assert len(fake_db.stock_movements.documents) == 1
            assert fake_db.stock_movements.documents[0]["quantity"] == 8
            assert len(fake_db.prices.documents) == 2
            assert (await server.resolve_price(1, "Premium Foam", "600x100"))["price"] == 60
            assert (await server.resolve_price(2, "Premium Foam", "600x100"))["price"] == 70
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_grv_new_product_requires_sale_price_in_each_superiqfoam_zone(monkeypatch):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": "superiqfoam",
    }

    async def scenario():
        company_token = server.active_company_id.set("superiqfoam")
        try:
            grv = await server.create_grv(server.GRVIn(
                supplier_name="New Product Supplier",
                received_date="2026-10-29",
                items=[server.GRVLineIn(
                    new_product=True,
                    product="Unpriced Foam",
                    size="600x100",
                    actual_received_quantity=1,
                    accepted_quantity=1,
                    sale_price_zone_1=60,
                )],
            ), user)
            with pytest.raises(HTTPException) as missing_zone_price:
                await server.confirm_grv(grv["id"], user)
            assert missing_zone_price.value.status_code == 400
            assert len(fake_db.stock.documents) == 1
            assert fake_db.prices.documents == []
            assert (await fake_db.grvs.find_one({"id": grv["id"]}))["status"] == "draft"
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


@pytest.mark.parametrize("company_id", ["iqfoam-manufactoring", "iqfoam-whole-sallers"])
def test_unified_price_company_grv_creates_new_product_with_one_price(monkeypatch, company_id):
    fake_db = FakeDatabase()
    _install_fake_grv_dependencies(monkeypatch, fake_db)
    user = {
        "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": company_id,
    }

    async def scenario():
        company_token = server.active_company_id.set(company_id)
        try:
            grv = await server.create_grv(server.GRVIn(
                supplier_name="New Product Supplier",
                received_date="2026-10-29",
                items=[server.GRVLineIn(
                    new_product=True,
                    product="Premium Foam",
                    size="600x100",
                    actual_received_quantity=2,
                    accepted_quantity=2,
                    sale_price_zone_1=60,
                )],
            ), user)
            confirmed = await server.confirm_grv(grv["id"], user)
            stock_item = next(
                item for item in fake_db.stock.documents
                if item["id"] == confirmed["items"][0]["stock_id"]
            )
            assert stock_item["product"] == "Premium Foam"
            assert [(price["zone"], price["price"]) for price in fake_db.prices.documents] == [(1, 60)]
            assert (await server.resolve_price(1, "Premium Foam", "600x100"))["price"] == 60
        finally:
            server.active_company_id.reset(company_token)

    asyncio.run(scenario())


def test_only_global_or_active_company_owner_can_delete_grv(monkeypatch):
    fake_db = FakeDatabase()
    fake_db.grvs.documents.extend([
        {"id": "company-owner-grv", "grv_number": "GRV-OWNER", "status": "draft"},
        {"id": "global-owner-grv", "grv_number": "GRV-GLOBAL", "status": "draft"},
        {"id": "admin-grv", "grv_number": "GRV-ADMIN", "status": "draft"},
        {"id": "worker-grv", "grv_number": "GRV-WORKER", "status": "draft"},
    ])
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    company_owner = {
        "id": "company-owner", "email": "company-owner@example.test",
        "role": "user", "_active_role": "owner",
        "_active_company_id": "test-company",
        "company_roles": {"test-company": "owner"},
    }
    global_owner = {
        "id": "global-owner", "email": "global-owner@example.test",
        "role": "owner", "_active_role": "owner",
        "_active_company_id": "test-company",
    }
    admin = {
        "id": "admin", "email": "admin@example.test",
        "_active_role": "admin", "_active_company_id": "test-company",
    }
    worker = {
        "id": "worker", "email": "worker@example.test", "is_worker": True,
        "_active_role": "user", "_active_company_id": "test-company",
        "worker_allowed_sections": ["grv"],
    }

    async def scenario():
        with pytest.raises(HTTPException) as admin_denied:
            await server.delete_grv("admin-grv", server.GRVDeleteIn(), admin)
        assert admin_denied.value.status_code == 403

        with pytest.raises(HTTPException) as worker_denied:
            await server.delete_grv("worker-grv", server.GRVDeleteIn(), worker)
        assert worker_denied.value.status_code == 403

        deleted = await server.delete_grv("company-owner-grv", server.GRVDeleteIn(), company_owner)
        assert deleted == {"ok": True, "deleted": True}
        assert await fake_db.grvs.find_one({"id": "company-owner-grv"}) is None

        global_deleted = await server.delete_grv(
            "global-owner-grv", server.GRVDeleteIn(), global_owner,
        )
        assert global_deleted == {"ok": True, "deleted": True}

    asyncio.run(scenario())


def test_company_owner_can_bulk_delete_eligible_grvs_and_receives_per_item_failures(monkeypatch):
    fake_db = FakeDatabase()
    fake_db.grvs.documents.extend([
        {"id": "draft-grv", "grv_number": "GRV-DRAFT", "status": "draft"},
        {"id": "cancelled-grv", "grv_number": "GRV-CANCELLED", "status": "cancelled"},
        {"id": "confirmed-grv", "grv_number": "GRV-CONFIRMED", "status": "completed"},
    ])
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    owner = {
        "id": "owner", "email": "owner@example.test", "_active_role": "owner",
        "_active_company_id": "test-company",
    }

    async def scenario():
        result = await server.bulk_delete_grvs(
            server.GRVBulkDeleteIn(ids=[
                "draft-grv", "cancelled-grv", "confirmed-grv", "missing-grv",
            ]),
            owner,
        )
        assert result["deleted"] == [
            {"id": "draft-grv", "grv_number": "GRV-DRAFT"},
            {"id": "cancelled-grv", "grv_number": "GRV-CANCELLED"},
        ]
        assert result["failed"] == [
            {"id": "confirmed-grv", "message": "Reverse a confirmed GRV before deleting it"},
            {"id": "missing-grv", "message": "GRV not found"},
        ]
        assert [grv["id"] for grv in fake_db.grvs.documents] == ["confirmed-grv"]

        with pytest.raises(HTTPException) as admin_denied:
            await server.bulk_delete_grvs(
                server.GRVBulkDeleteIn(ids=["confirmed-grv"]),
                {"_active_role": "admin", "_active_company_id": "test-company"},
            )
        assert admin_denied.value.status_code == 403

    asyncio.run(scenario())
