import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import server


def make_request(path):
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 443),
    })


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, *_args):
        return self

    async def to_list(self, length):
        return deepcopy(self.documents[:length])


def test_admin_worker_bypasses_worker_sections_but_remains_worker_scoped():
    admin_worker = {
        "is_worker": True,
        "_active_role": "admin",
        "worker_allowed_sections": [],
    }
    ordinary_worker = {
        "is_worker": True,
        "_active_role": "user",
        "worker_allowed_sections": [],
    }

    assert not server.worker_restrictions_apply(admin_worker)
    assert server.worker_restrictions_apply(ordinary_worker)
    server.enforce_worker_api_access(make_request("/api/fleet"), admin_worker)
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(make_request("/api/fleet"), ordinary_worker)
    assert error.value.status_code == 403
    assert server.is_delegated_company_admin({
        **admin_worker,
        "company_roles": {server.DEFAULT_COMPANY_ID: "admin"},
    })


def test_admin_worker_public_role_is_admin_without_company_switch_access(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    account = {
        "id": "worker-admin",
        "email": "worker-admin@example.test",
        "role": "user",
        "is_worker": True,
        "_active_role": "admin",
        "_active_company_id": server.DEFAULT_COMPANY_ID,
        "company_roles": {server.DEFAULT_COMPANY_ID: "admin", "another-company": "admin"},
        "worker_allowed_sections": ["stock"],
    }

    public = server.public_user(account)
    assert public["role"] == "admin"
    assert public["is_admin"]
    assert not public["is_worker"]
    assert public["is_worker_account"]
    assert not public["can_switch_company"]

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.switch_company(
            server.SwitchCompanyIn(company_id="another-company"), account,
        ))
    assert error.value.status_code == 403


def test_invoice_update_records_before_after_actor_and_timestamp(monkeypatch):
    existing = {
        "id": "invoice-1",
        "customer_name": "Before",
        "status": "issued",
        "number": "100",
        "amount_paid": 0,
        "items": [],
        "audit": [],
    }
    stored = deepcopy(existing)
    audit_calls = []

    class Invoices:
        async def find_one(self, *_args, **_kwargs):
            return deepcopy(existing)

    async def noop(*_args, **_kwargs):
        return None

    async def prepare(body, **_kwargs):
        return body.model_dump()

    def compute(invoice):
        invoice["total"] = 1
        invoice["outstanding"] = 1

    async def update_doc(_collection, _invoice_id, updates):
        stored.update(deepcopy(updates))
        return deepcopy(stored)

    async def listall(*_args, **_kwargs):
        return []

    async def log_audit(*args, **kwargs):
        audit_calls.append((args, kwargs))

    monkeypatch.setattr(server, "db", SimpleNamespace(invoices=Invoices()))
    monkeypatch.setattr(server, "consume_invoice_action_authorization", noop)
    monkeypatch.setattr(server, "validate_invoice_item_price_edits", noop)
    monkeypatch.setattr(server, "_prepare_invoice", prepare)
    monkeypatch.setattr(server, "compute_invoice", compute)
    monkeypatch.setattr(server, "validate_for_issue", noop)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "log_audit", log_audit)
    monkeypatch.setattr(server, "emit_workflow_event", noop)
    monkeypatch.setattr(server, "derive_status", lambda _invoice: "issued")

    result = asyncio.run(server.update_invoice(
        "invoice-1",
        server.InvoiceIn(customer_name="After", edit_reason="Corrected customer name"),
        {"id": "worker-1", "email": "worker@example.test", "is_worker": True, "_active_role": "user"},
    ))

    assert result["customer_name"] == "After"
    assert "audit" not in result
    audit_args, audit_kwargs = audit_calls[0]
    assert audit_args[:3] == ("invoice", "invoice-1", "invoice_edited")
    assert audit_args[3]["email"] == "worker@example.test"
    assert audit_kwargs["before"]["customer_name"] == "Before"
    assert audit_kwargs["after"]["customer_name"] == "After"
    assert audit_kwargs["reason"] == "Corrected customer name"


def test_audit_log_stores_actor_display_name_and_id(monkeypatch):
    stored = []

    class AuditLog:
        async def insert_one(self, entry):
            stored.append(entry)

    monkeypatch.setattr(server, "db", SimpleNamespace(audit_log=AuditLog()))
    asyncio.run(server.log_audit(
        "invoice", "invoice-1", "invoice_edited",
        {"id": "worker-1", "email": "", "username": "ayanda.tailor", "name": "Ayanda Tailor"},
    ))

    assert stored[0]["user"] == "ayanda.tailor"
    assert stored[0]["user_id"] == "worker-1"
    assert stored[0]["user_name"] == "Ayanda Tailor"


def test_invoice_audit_endpoint_is_owner_only_and_returns_full_history(monkeypatch):
    history = [{
        "id": "audit-1",
        "user": "worker@example.test",
        "user_name": "worker@example.test",
        "at": "2026-01-01T10:00:00",
        "before": {},
        "after": {},
    }]

    class AuditLog:
        def find(self, query, _projection=None):
            assert query["entity"] == "invoice"
            assert query["entity_id"] == "invoice-1"
            assert "invoice_edited" in query["action"]["$in"]
            return Cursor(history)

    class Invoices:
        async def find_one(self, *_args, **_kwargs):
            return {"id": "invoice-1"}

    class Users:
        def find(self, query, _projection=None):
            assert query == {"$or": [{"email": {"$in": ["worker@example.test"]}}]}
            return Cursor([{
                "id": "worker-1",
                "email": "worker@example.test",
                "name": "Ayanda Tailor",
                "username": "ayanda",
            }])

    monkeypatch.setattr(server, "db", SimpleNamespace(invoices=Invoices(), audit_log=AuditLog()))
    monkeypatch.setattr(server, "base_db", SimpleNamespace(users=Users()))

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_invoice_audit("invoice-1", {"_active_role": "admin"}))
    assert error.value.status_code == 403

    result = asyncio.run(server.get_invoice_audit("invoice-1", {"_active_role": "owner"}))
    assert result[0]["user_name"] == "Ayanda Tailor"
    assert result[0]["user"] == "worker@example.test"


def test_generic_audit_hides_invoice_records_from_nonowners(monkeypatch):
    captured = {}

    class AuditLog:
        def find(self, query, _projection=None):
            captured.update(query)
            return Cursor([])

    monkeypatch.setattr(server, "db", SimpleNamespace(audit_log=AuditLog()))
    asyncio.run(server.get_audit(user={"_active_role": "admin"}))
    assert captured["entity"] == {"$ne": "invoice"}


def test_stock_costs_are_owner_only_in_stock_movement_responses(monkeypatch):
    movements = [{
        "id": "movement-1",
        "quantity": 2,
        "unit_cost": 50,
        "batch_allocations": [{"quantity": 1, "unit_cost": 25, "cost_status": "verified"}],
    }]

    async def listall(*_args, **_kwargs):
        return deepcopy(movements)

    monkeypatch.setattr(server, "listall", listall)
    admin_result = asyncio.run(server.get_movements({"_active_role": "admin"}))
    assert admin_result == [{"id": "movement-1", "quantity": 2, "batch_allocations": [{"quantity": 1}]}]
    owner_result = asyncio.run(server.get_movements({"_active_role": "owner"}))
    assert owner_result == movements


def test_stock_list_api_redacts_unit_cost_for_admins(monkeypatch):
    async def listall(*_args, **_kwargs):
        return [{"id": "stock-1", "product": "Foam", "size": "100x100", "opening": 2, "unit_cost": 50}]

    async def movement_totals(_stock_ids):
        return {}

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "stock_movements_for_stock_ids", movement_totals)

    admin = asyncio.run(server.get_stock({"_active_role": "admin"}))
    owner = asyncio.run(server.get_stock({"_active_role": "owner"}))
    assert "unit_cost" not in admin[0]
    assert owner[0]["unit_cost"] == 50


def test_stock_cost_redaction_keeps_selling_prices_separate():
    stock = {"unit_cost": 20, "selling_price": 100, "product": "Foam"}
    assert server.stock_for_user(stock, {"_active_role": "admin"}) == {
        "selling_price": 100, "product": "Foam",
    }
    assert server.stock_for_user(stock, {"_active_role": "owner"})["unit_cost"] == 20
