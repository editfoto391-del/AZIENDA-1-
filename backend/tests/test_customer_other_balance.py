import asyncio

import pytest

import server


class Customers:
    def __init__(self, doc):
        self.doc = doc

    async def find_one(self, q, p=None):
        return self.doc if q.get("id") == self.doc["id"] else None


def test_summary_splits_invoices_and_other_balance(monkeypatch):
    invoices = [
        {
            "id": "i1", "total": 100, "outstanding": 100, "status": "issued",
            "due_date": "2999-01-01", "audit": [{"action": "edited", "by": "private"}],
        },
    ]

    async def listall(name, *a, **k):
        return [dict(i) for i in invoices] if name == "invoices" else []

    class DB:
        customers = Customers({"id": "c1", "other_balance": 250.5})

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "derive_status", lambda i: "issued")
    result = asyncio.run(server.customer_summary("c1", user={}))
    assert result["invoices_outstanding"] == 100
    assert result["other_balance"] == 250.5
    assert "audit" not in result["invoices"][0]


def test_summary_separates_express_other_balance_payments(monkeypatch):
    payments = [
        {"id": "standard-payment", "other_balance_payment": True, "express": False},
        {"id": "express-payment", "other_balance_payment": True, "express": True},
    ]

    async def listall(name, *a, **k):
        if name == "payments":
            return [dict(payment) for payment in payments]
        return []

    class DB:
        customers = Customers({"id": "c1", "other_balance": 100, "other_balance_express": True})

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "derive_status", lambda invoice: invoice.get("status", "issued"))
    standard = asyncio.run(server.customer_summary("c1", express_only=False, user={}))
    express = asyncio.run(server.customer_summary("c1", express_only=True, user={}))

    assert [payment["id"] for payment in standard["other_balance_payments"]] == ["standard-payment"]
    assert [payment["id"] for payment in express["other_balance_payments"]] == ["express-payment"]


def test_summary_keeps_reversed_invoice_payments_in_history(monkeypatch):
    payments = [
        {"id": "active-payment", "amount": 40, "invoice_id": "i1"},
        {"id": "reversed-payment", "amount": 25, "invoice_id": "i1", "reversed": True},
        {"id": "archived-payment", "amount": 15, "invoice_id": "i1", "archived": True},
    ]

    async def listall(name, *a, **k):
        if name == "payments":
            return [dict(payment) for payment in payments]
        return []

    class DB:
        customers = Customers({"id": "c1", "other_balance": 0})

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "derive_status", lambda invoice: invoice.get("status", "issued"))
    result = asyncio.run(server.customer_summary("c1", user={}))

    assert [payment["id"] for payment in result["payments"]] == [
        "active-payment", "reversed-payment", "archived-payment",
    ]
    assert result["payments_received"] == 40


def test_payments_endpoint_includes_archived_and_reversed_history(monkeypatch):
    payments = [
        {"id": "reversed", "reversed": True},
        {"id": "archived", "archived": True},
    ]

    async def listall(name, *args, **kwargs):
        assert name == "payments"
        assert not args
        assert kwargs["sort"] == ("created_at", -1)
        return payments

    monkeypatch.setattr(server, "listall", listall)
    assert asyncio.run(server.get_payments(user={})) == payments


def test_pay_other_balance(monkeypatch):
    import pytest
    from fastapi import HTTPException

    doc = {"id": "c1", "other_balance": 100}

    class DB:
        customers = Customers(doc)

    async def update_doc(name, cid, data):
        doc.update(data)
        return dict(doc)

    async def noop(*a, **k):
        return None

    async def insert(name, data):
        return {**data, "id": "p0"}

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", noop)
    result = asyncio.run(server.pay_other_balance("c1", server.OtherBalancePayIn(amount=40), user={"id": "u", "email": "a@b.c"}))
    assert result["other_balance"] == 60
    assert result["other_balance_payments"][0]["amount"] == 40
    with pytest.raises(HTTPException):
        asyncio.run(server.pay_other_balance("c1", server.OtherBalancePayIn(amount=61), user={"id": "u"}))


def test_pay_other_balance_records_payment(monkeypatch):
    doc = {"id": "c1", "name": "Acme", "other_balance": 100}
    payments = []

    class DB:
        customers = Customers(doc)

    async def insert(name, data):
        rec = {**data, "id": "p1"}
        payments.append(rec)
        return rec

    async def update_doc(name, cid, data):
        doc.update(data)
        return dict(doc)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", noop)
    body = server.OtherBalancePayIn(amount=30, method="EFT", receiving_on="Bank", express=True)
    result = asyncio.run(server.pay_other_balance("c1", body, user={"id": "u", "email": "a@b.c"}))
    assert result["other_balance"] == 70
    assert payments[0]["other_balance_payment"] and payments[0]["express"] and payments[0]["invoice_id"] is None
    assert payments[0]["method"] == "EFT"


def test_other_balance_payment_history_cannot_be_deleted():
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.delete_other_balance_payment("p1", user={"id": "u"}))
    assert error.value.status_code == 409


def test_legacy_other_balance_history_cannot_be_deleted():
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.delete_other_balance_payment("legacy-p1", user={"id": "u"}))
    assert error.value.status_code == 409


def test_legacy_other_balance_history_entry_cannot_be_deleted():
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.delete_legacy_other_balance_history("c1", 0, user={"id": "u"}))
    assert error.value.status_code == 409


def test_invoice_payment_history_cannot_be_deleted():
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.delete_invoice_payment(
            "p1", server.ReasonIn(reason="Duplicate payment"), user={"id": "u"},
        ))
    assert error.value.status_code == 409
