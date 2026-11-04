import asyncio

import server


class Customers:
    def __init__(self, doc):
        self.doc = doc

    async def find_one(self, q, p=None):
        return self.doc if q.get("id") == self.doc["id"] else None


def test_summary_splits_invoices_and_other_balance(monkeypatch):
    invoices = [
        {"id": "i1", "total": 100, "outstanding": 100, "status": "issued", "due_date": "2999-01-01"},
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

    assert [payment["id"] for payment in result["payments"]] == ["active-payment", "reversed-payment"]
    assert result["payments_received"] == 40


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


def test_delete_other_balance_payment_keeps_balance(monkeypatch):
    calls = []
    payment = {"id": "p1", "customer_id": "c1", "amount": 30, "other_balance_payment": True}

    class Coll:
        async def find_one(self, q, p=None):
            return dict(payment)

        async def update_one(self, q, u):
            calls.append(u)

        async def delete_one(self, q):
            calls.append("deleted")

    class DB:
        customers = Coll()
        payments = Coll()

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "log_audit", noop)
    asyncio.run(server.delete_other_balance_payment("p1", user={"id": "u"}))
    assert not any(isinstance(c, dict) and "$inc" in c for c in calls)
    assert "deleted" in calls


def test_delete_legacy_other_balance_history_without_payment_record(monkeypatch):
    history_entry = {"payment_id": "legacy-p1", "amount": 30, "date": "2026-01-01"}
    customer = {"id": "c1", "other_balance": 70, "other_balance_payments": [history_entry.copy()]}
    calls = []

    class Customers:
        async def find_one(self, query, projection=None):
            return customer if query.get("other_balance_payments.payment_id") == "legacy-p1" else None

        async def update_one(self, query, update):
            customer["other_balance_payments"] = [
                entry for entry in customer["other_balance_payments"]
                if entry.get("payment_id") != update["$pull"]["other_balance_payments"]["payment_id"]
            ]
            calls.append(update)

    class Payments:
        async def find_one(self, query, projection=None):
            return None

        async def delete_one(self, query):
            calls.append(("deleted-payment", query))

    class DB:
        customers = Customers()
        payments = Payments()

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "log_audit", noop)
    result = asyncio.run(server.delete_other_balance_payment("legacy-p1", user={"id": "u"}))

    assert result == {"ok": True, "deleted": True}
    assert customer["other_balance_payments"] == []
    assert customer["other_balance"] == 70
    assert not any(isinstance(call, tuple) and call[0] == "deleted-payment" for call in calls)


def test_delete_legacy_history_entry_without_any_payment_id(monkeypatch):
    history = [
        {"amount": 30, "date": "2026-01-01"},
        {"amount": 25, "date": "2026-01-02"},
    ]
    customer = {"id": "c1", "other_balance": 70, "other_balance_payments": history.copy()}

    class Customers:
        async def find_one(self, query, projection=None):
            return dict(customer)

        async def update_one(self, query, update):
            assert query == {"id": "c1", "other_balance_payments": history}
            customer.update(update["$set"])
            return type("UpdateResult", (), {"matched_count": 1})()

    class Payments:
        async def find_one(self, query, projection=None):
            return None

    class DB:
        customers = Customers()
        payments = Payments()

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "log_audit", noop)
    result = asyncio.run(
        server.delete_legacy_other_balance_history("c1", 0, user={"id": "u"})
    )

    assert result == {"ok": True, "deleted": True}
    assert customer["other_balance_payments"] == [history[1]]
    assert customer["other_balance"] == 70


def test_delete_invoice_payment_requires_authorization_and_recalculates(monkeypatch):
    payment = {"id": "p1", "invoice_id": "i1", "amount": 30}
    calls = []

    class Payments:
        async def find_one(self, query, projection=None):
            return dict(payment) if query.get("id") == payment["id"] else None

        async def find_one_and_delete(self, query, projection=None):
            calls.append(("deleted", query))
            return dict(payment)

    class DB:
        payments = Payments()

    async def authorize(*args):
        calls.append(("authorized", args))

    async def recalculate(invoice_id):
        calls.append(("recalculated", invoice_id))

    async def audit(*args, **kwargs):
        calls.append(("audited", kwargs.get("reason")))

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "consume_invoice_action_authorization", authorize)
    monkeypatch.setattr(server, "recalc_invoice_payments", recalculate)
    monkeypatch.setattr(server, "log_audit", audit)
    result = asyncio.run(server.delete_invoice_payment(
        "p1",
        server.ReasonIn(reason="Duplicate payment", supervisor_authorization="approval"),
        user={"id": "u", "email": "user@example.com"},
    ))

    assert result == {"ok": True, "deleted": True}
    assert calls[0][0] == "authorized"
    assert calls[0][1][2:] == ("delete_payment", {"id": "u", "email": "user@example.com"}, "p1")
    assert ("recalculated", "i1") in calls
    assert ("audited", "Duplicate payment") in calls
