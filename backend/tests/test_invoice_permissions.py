import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import server


def make_request(path, method):
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 443),
    })


def test_admin_invoice_edit_does_not_need_supervisor_password():
    admin = {"_active_role": "admin", "company_roles": {server.DEFAULT_COMPANY_ID: "admin"}}
    worker_admin = {
        "_active_role": "admin",
        "is_worker": True,
        "worker_allowed_sections": ["invoices"],
        "worker_write_permissions": {"invoices": {"update": "allow", "create": "allow", "delete": "supervisor"}},
    }

    assert server.can_edit_invoice_without_supervisor(admin)
    assert server.can_edit_invoice_without_supervisor(worker_admin)

    worker_admin["worker_write_permissions"]["invoices"]["update"] = "supervisor"
    assert server.can_edit_invoice_without_supervisor(worker_admin)


def test_admin_invoice_edit_skips_general_supervisor_write_gate():
    async def scenario():
        request = make_request("/api/invoices/invoice-1", "PUT")
        admin = {
            "_active_role": "admin",
            "company_roles": {server.DEFAULT_COMPANY_ID: "admin"},
            "_active_company_id": server.DEFAULT_COMPANY_ID,
        }
        await server.require_supervisor_for_company_write(request, admin)

    asyncio.run(scenario())


def test_admin_invoice_delete_requires_supervisor_password():
    async def scenario():
        request = make_request("/api/invoices/invoice-1", "DELETE")
        admin = {
            "_active_role": "admin",
            "company_roles": {server.DEFAULT_COMPANY_ID: "admin"},
            "_active_company_id": server.DEFAULT_COMPANY_ID,
            "id": "admin-1",
            "_session_id": "session-1",
        }
        with pytest.raises(HTTPException) as error:
            await server.require_supervisor_for_company_write(request, admin)
        assert error.value.status_code == 428

    asyncio.run(scenario())


def test_invoice_delete_worker_permission_requires_supervisor_and_rejects_allow():
    assert server.worker_write_scope("/api/invoices/bulk-delete", "POST", {
        "worker_allowed_sections": ["invoices"],
    }) == ("invoices", "delete")
    with pytest.raises(HTTPException, match="always requires the Supervisor Password"):
        server.validate_worker_write_permissions(
            {"invoices": {"create": "allow", "update": "allow", "delete": "allow"}},
            ["invoices"],
        )
    assert server.validate_worker_write_permissions({}, ["invoices"]) == {
        "invoices": {"create": "deny", "update": "deny", "delete": "deny"},
    }


def test_worker_invoice_price_permission_requires_invoice_access():
    assert server.validate_worker_invoice_price_permission(True, ["express-invoices"])
    assert not server.validate_worker_invoice_price_permission(False, ["stock"])
    with pytest.raises(HTTPException, match="requires invoice section access"):
        server.validate_worker_invoice_price_permission(True, ["stock"])


def test_archived_invoice_list_is_owner_only():
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_invoices(
            include_archived=True,
            user={"_active_role": "admin"},
        ))
    assert error.value.status_code == 403


def test_admin_can_delete_invoice_by_archiving_it(monkeypatch):
    class Invoices:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "invoice-1", "archived": False}

    updates = []

    async def update_doc(collection, invoice_id, fields):
        updates.append((collection, invoice_id, fields))

    async def log_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(invoices=Invoices()))
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", log_audit)

    result = asyncio.run(server.delete_invoice(
        "invoice-1",
        user={"_active_role": "admin", "id": "admin-1"},
    ))

    assert result == {"ok": True, "archived": True, "stock_restored": False}
    assert len(updates) == 1
    collection, invoice_id, fields = updates[0]
    assert (collection, invoice_id) == ("invoices", "invoice-1")
    assert fields["archived"] is True
    assert fields["archived_at"]
    assert fields["archived_by"] == "admin-1"


def test_admin_cannot_permanently_delete_archived_invoice():
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.permanently_delete_invoice(
            "invoice-1",
            user={"_active_role": "admin"},
        ))
    assert error.value.status_code == 403


@pytest.mark.parametrize("user", [
    {"_active_role": "admin"},
    {"_active_role": "owner", "is_worker": True},
])
def test_workers_and_admins_cannot_access_settings(user):
    with pytest.raises(HTTPException) as error:
        server.require_settings_owner(user)
    assert error.value.status_code == 403


def test_company_owner_can_access_settings():
    server.require_settings_owner({"_active_role": "owner", "is_worker": False})


def test_non_owner_cannot_open_an_archived_invoice(monkeypatch):
    class Invoices:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "invoice-1", "archived": True}

    monkeypatch.setattr(server, "db", SimpleNamespace(invoices=Invoices()))
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_invoice("invoice-1", {"_active_role": "admin"}))
    assert error.value.status_code == 404


def test_bulk_permanent_invoice_delete_can_preserve_payment_history(monkeypatch):
    class Collection:
        def __init__(self, documents=()):
            self.documents = list(documents)

        async def find_one(self, query, _projection=None):
            return next((item.copy() for item in self.documents if item["id"] == query["id"]), None)

        async def count_documents(self, query):
            return sum(all(item.get(key) == value for key, value in query.items()) for item in self.documents)

        async def delete_one(self, query):
            self.documents = [
                item for item in self.documents
                if not all(item.get(key) == value for key, value in query.items())
            ]

        async def delete_many(self, query):
            self.documents = [
                item for item in self.documents
                if not all(item.get(key) == value for key, value in query.items())
            ]

    invoices = Collection([
        {"id": "archived-1", "archived": True, "number": "1"},
        {"id": "archived-2", "archived": True, "number": "2"},
    ])
    payments = Collection([
        {"id": "payment-1", "invoice_id": "archived-1"},
        {"id": "payment-2", "invoice_id": "archived-2"},
    ])
    share_links = Collection([
        {"id": "link-1", "invoice_id": "archived-1"},
        {"id": "link-2", "invoice_id": "archived-2"},
    ])
    monkeypatch.setattr(server, "db", SimpleNamespace(
        invoices=invoices, payments=payments, invoice_share_links=share_links,
    ))
    audits = []

    async def log_audit(*args, **kwargs):
        audits.append((args, kwargs))

    monkeypatch.setattr(server, "log_audit", log_audit)
    result = asyncio.run(server.bulk_permanently_delete_invoices(
        server.BulkPermanentDeleteIn(ids=["archived-1", "archived-2", "archived-1"]),
        {"_active_role": "owner"},
    ))

    assert result == {"deleted": 2, "payments_reversed": 0}
    assert invoices.documents == []
    assert len(payments.documents) == 2
    assert share_links.documents == []
    assert [entry[0][2] for entry in audits] == ["permanently_deleted", "permanently_deleted"]


def test_bulk_permanent_invoice_delete_can_reverse_payment_history(monkeypatch):
    class Cursor:
        def __init__(self, documents):
            self.documents = documents

        async def to_list(self, _length):
            return self.documents

    class Collection:
        def __init__(self, documents=()):
            self.documents = list(documents)

        async def find_one(self, query, _projection=None):
            return next((item.copy() for item in self.documents if item["id"] == query["id"]), None)

        def find(self, query, _projection=None):
            invoice_filter = query["invoice_id"]
            invoice_ids = invoice_filter["$in"] if isinstance(invoice_filter, dict) else [invoice_filter]
            return Cursor([
                item.copy() for item in self.documents
                if item.get("invoice_id") in invoice_ids
                and item.get("reversed") is not True
            ])

        async def find_one_and_update(self, query, update, **_kwargs):
            payment = next((item for item in self.documents if item["id"] == query["id"]), None)
            if not payment or payment.get("reversed") is True:
                return None
            payment.update(update["$set"])
            return payment.copy()

        async def delete_one(self, query):
            self.documents = [
                item for item in self.documents
                if not all(item.get(key) == value for key, value in query.items())
            ]

    invoices = Collection([{"id": "archived-1", "archived": True, "number": "1"}])
    payments = Collection([
        {"id": "payment-active", "invoice_id": "archived-1", "reversed": False},
        {"id": "payment-reversed", "invoice_id": "archived-1", "reversed": True},
    ])
    share_links = Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        invoices=invoices, payments=payments, invoice_share_links=share_links,
    ))
    audits = []
    events = []

    async def log_audit(*args, **kwargs):
        audits.append((args, kwargs))

    async def emit_workflow_event(*args):
        events.append(args)

    monkeypatch.setattr(server, "log_audit", log_audit)
    monkeypatch.setattr(server, "emit_workflow_event", emit_workflow_event)
    result = asyncio.run(server.bulk_permanently_delete_invoices(
        server.BulkPermanentDeleteIn(ids=["archived-1"], reverse_payments=True),
        {"_active_role": "owner", "email": "owner@example.test"},
    ))

    assert result == {"deleted": 1, "payments_reversed": 1}
    assert invoices.documents == []
    assert payments.documents[0]["reversed"] is True
    assert payments.documents[0]["reversed_reason"]
    assert payments.documents[0]["reversed_by"] == "owner@example.test"
    assert payments.documents[1]["reversed"] is True
    assert events == [("payment.reversed", payments.documents[0])]
    assert [entry[0][2] for entry in audits] == ["reversed", "permanently_deleted"]


def test_bulk_permanent_invoice_delete_validates_all_records_before_deleting(monkeypatch):
    class Invoices:
        def __init__(self):
            self.documents = [
                {"id": "archived-1", "archived": True},
                {"id": "active-1", "archived": False},
            ]

        async def find_one(self, query, _projection=None):
            return next((item.copy() for item in self.documents if item["id"] == query["id"]), None)

    invoices = Invoices()
    class Payments:
        async def count_documents(self, _query):
            return 0

    monkeypatch.setattr(server, "db", SimpleNamespace(invoices=invoices, payments=Payments()))
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.bulk_permanently_delete_invoices(
            server.BulkPermanentDeleteIn(ids=["archived-1", "active-1"]),
            {"_active_role": "owner"},
        ))

    assert error.value.status_code == 409
    assert len(invoices.documents) == 2


def test_bulk_permanent_invoice_delete_is_owner_only():
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.bulk_permanently_delete_invoices(
            server.BulkPermanentDeleteIn(ids=["invoice-1"]),
            {"_active_role": "admin"},
        ))
    assert error.value.status_code == 403


def test_admin_can_change_existing_invoice_item_price(monkeypatch):
    async def scenario():
        body = server.InvoiceIn(items=[{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 13,
            "price_override": True,
        }])
        existing = {"items": [{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 12.5,
            "price_override": False,
        }]}

        await server.validate_invoice_item_price_edits(
            body, existing, {"_active_role": "admin"},
        )

        worker_admin = {
            "is_worker": True,
            "_active_role": "admin",
            "worker_can_edit_invoice_prices": False,
        }
        await server.validate_invoice_item_price_edits(body, existing, worker_admin)

    async def price_lookup(*_args):
        return {"price": 12.5}

    monkeypatch.setattr(server, "resolve_price", price_lookup)
    asyncio.run(scenario())


def test_admin_can_add_invoice_item_with_custom_price(monkeypatch):
    async def price_lookup(*_args):
        return {"price": 12.5}

    monkeypatch.setattr(server, "resolve_price", price_lookup)

    async def scenario():
        custom = server.InvoiceIn(items=[{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 20,
            "price_override": True,
        }])
        await server.validate_invoice_item_price_edits(
            custom, None, {"_active_role": "admin"},
        )

    asyncio.run(scenario())


def test_worker_invoice_price_edit_requires_explicit_permission(monkeypatch):
    async def price_lookup(*_args):
        return {"price": 12.5}

    monkeypatch.setattr(server, "resolve_price", price_lookup)

    async def scenario():
        existing = {"items": [{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 12.5,
            "price_override": False,
        }]}
        changed = server.InvoiceIn(items=[{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 13,
            "price_override": True,
        }])
        worker = {"is_worker": True, "_active_role": "user"}

        with pytest.raises(HTTPException, match="Workers cannot change invoice item prices"):
            await server.validate_invoice_item_price_edits(changed, existing, worker)

        await server.validate_invoice_item_price_edits(
            changed, existing, {**worker, "worker_can_edit_invoice_prices": True},
        )

        custom_new_item = server.InvoiceIn(items=[{
            "category": "Foam",
            "size": "100x100",
            "unit_price": 13,
            "price_override": True,
        }])
        with pytest.raises(HTTPException, match="Workers can only add invoice items at a configured price"):
            await server.validate_invoice_item_price_edits(custom_new_item, None, worker)

    asyncio.run(scenario())
