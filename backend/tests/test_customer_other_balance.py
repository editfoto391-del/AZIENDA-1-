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

def test_invoice_contact_update_only_changes_customer_phone_and_city(monkeypatch):
    customer = {"id": "c1", "name": "Acme", "phone": "old phone", "city": "Old city"}
    calls = {}

    class DB:
        customers = Customers(customer)

    async def update_doc(collection, cid, data):
        calls["update"] = (collection, cid, data)
        return {**customer, **data}

    async def record_audit(*args, **kwargs):
        calls["audit"] = (args, kwargs)

    async def emit_event(*args, **kwargs):
        calls["event"] = (args, kwargs)

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", record_audit)
    monkeypatch.setattr(server, "emit_workflow_event", emit_event)

    result = asyncio.run(server.update_customer_invoice_contact(
        "c1",
        server.CustomerInvoiceContactIn(phone="new phone"),
        user={"id": "u1"},
    ))

    assert result["name"] == "Acme"
    assert result["phone"] == "new phone"
    assert result["city"] == "Old city"
    assert calls["update"] == (
        "customers", "c1", {"phone": "new phone"},
    )
    assert calls["audit"][0][2] == "invoice_contact_updated"
    assert calls["event"][0] == ("customer.updated", result)


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


def test_summary_counts_advance_receipt_once_and_exposes_remaining_credit(monkeypatch):
    payments = [
        {
            "id": "advance-1", "customer_id": "c1", "advance_payment": True,
            "amount": 100, "available_amount": 60, "invoice_id": None,
        },
        {
            "id": "allocation-1", "customer_id": "c1", "advance_allocation": True,
            "amount": 40, "invoice_id": "i1",
        },
    ]

    async def listall(name, *args, **kwargs):
        if name == "payments":
            return [dict(payment) for payment in payments]
        if name == "invoices":
            return [{"id": "i1", "total": 100, "outstanding": 60, "status": "issued"}]
        return []

    class DB:
        customers = Customers({"id": "c1", "other_balance": 0})

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "derive_status", lambda invoice: invoice.get("status", "issued"))
    result = asyncio.run(server.customer_summary("c1", user={}))

    assert result["advance_payments"][0]["available_amount"] == 60
    assert result["payments_received"] == 100


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


def test_advance_payment_is_saved_as_customer_credit(monkeypatch):
    customer = {"id": "c1", "name": "Acme"}
    payments = []

    class DB:
        customers = Customers(customer)

        class payments:
            @staticmethod
            async def find_one(*args, **kwargs):
                return None

    async def insert(name, data):
        record = {**data, "id": "advance-1"}
        payments.append(record)
        return record

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "log_audit", noop)
    monkeypatch.setattr(server, "emit_workflow_event", noop)

    record = asyncio.run(server.record_advance_payment(
        "c1",
        server.AdvancePaymentIn(
            amount=250,
            method="EFT",
            receiving_on="FNB",
            express=True,
            idempotency_key="advance-key",
        ),
        user={"id": "u", "email": "user@example.com"},
    ))

    assert record["advance_payment"] is True
    assert record["invoice_id"] is None
    assert record["available_amount"] == 250
    assert record["express"] is True
    assert record["customer_id"] == "c1"


def test_advance_payment_allocation_reduces_credit_and_links_customer_invoice(monkeypatch):
    advance = {
        "id": "advance-1",
        "customer_id": "c1",
        "customer_name": "Acme",
        "advance_payment": True,
        "amount": 100,
        "available_amount": 100,
        "method": "EFT",
        "date": "2026-11-14",
        "reversed": False,
    }
    invoice = {
        "id": "invoice-1",
        "customer_id": "c1",
        "customer_name": "Acme",
        "number": "INV-1",
        "status": "issued",
        "total": 70,
        "outstanding": 70,
        "audit": [],
    }
    allocations = []

    def matches(record, query):
        return all(
            record.get(key) != value["$ne"] if isinstance(value, dict) and "$ne" in value
            else record.get(key, 0) >= value["$gte"] if isinstance(value, dict) and "$gte" in value
            else record.get(key) == value
            for key, value in query.items()
        )

    class PaymentCollection:
        async def find_one(self, query, projection=None):
            return dict(advance) if matches(advance, query) else None

        async def find_one_and_update(self, query, update, **kwargs):
            if not matches(advance, query):
                return None
            advance.update(update.get("$set", {}))
            return dict(advance)

        async def update_one(self, query, update):
            if not matches(advance, query):
                return type("UpdateResult", (), {"matched_count": 0})()
            advance.update(update.get("$set", {}))
            for key, value in update.get("$inc", {}).items():
                advance[key] = advance.get(key, 0) + value
            for key in update.get("$unset", {}):
                advance.pop(key, None)
            return type("UpdateResult", (), {"matched_count": 1})()

    class InvoiceCollection:
        async def find_one(self, query, projection=None):
            return dict(invoice) if matches(invoice, query) else None

        async def find_one_and_update(self, query, update, **kwargs):
            if not matches(invoice, query):
                return None
            invoice.update(update.get("$set", {}))
            return dict(invoice)

        async def update_one(self, query, update):
            invoice.update(update.get("$set", {}))
            for key in update.get("$unset", {}):
                invoice.pop(key, None)
            return type("UpdateResult", (), {"matched_count": 1})()

    class DB:
        payments = PaymentCollection()
        invoices = InvoiceCollection()

    async def insert(name, data):
        record = {**data, "id": "allocation-1"}
        allocations.append(record)
        return record

    async def recalculate(_invoice_id):
        return dict(invoice)

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", DB())
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "recalc_invoice_payments", recalculate)
    monkeypatch.setattr(server, "log_audit", noop)
    monkeypatch.setattr(server, "emit_workflow_event", noop)

    record = asyncio.run(server.apply_advance_payment(
        "c1",
        "advance-1",
        server.AdvancePaymentApplyIn(invoice_id="invoice-1", amount=40, idempotency_key="apply-key"),
        user={"id": "u", "email": "user@example.com"},
    ))

    assert record["advance_allocation"] is True
    assert record["advance_payment_id"] == "advance-1"
    assert record["invoice_id"] == "invoice-1"
    assert record["amount"] == 40
    assert advance["available_amount"] == 60
    assert "advance_lock" not in advance
    assert "payment_lock" not in invoice
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.apply_advance_payment(
            "c1",
            "advance-1",
            server.AdvancePaymentApplyIn(invoice_id="invoice-1", amount=61, idempotency_key="too-much"),
            user={"id": "u", "email": "user@example.com"},
        ))
    assert error.value.status_code == 409
    assert advance["available_amount"] == 60
    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.apply_advance_payment(
            "other-customer",
            "advance-1",
            server.AdvancePaymentApplyIn(invoice_id="invoice-1", amount=10),
            user={"id": "u", "email": "user@example.com"},
        ))
    assert error.value.status_code == 404


def test_advance_payment_cannot_be_reversed_while_invoice_credit_is_allocated(monkeypatch):
    advance = {
        "id": "advance-1", "advance_payment": True,
        "reversed": False, "amount": 100,
    }

    class Allocations:
        async def to_list(self, length):
            return [{"id": "allocation-1"}]

    class Payments:
        async def find_one(self, query, projection=None):
            return dict(advance)

        def find(self, query):
            return Allocations()

    class DB:
        payments = Payments()

    monkeypatch.setattr(server, "db", DB())

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.reverse_payment(
            "advance-1",
            server.ReasonIn(reason="Incorrect advance"),
            user={"id": "u", "email": "user@example.com"},
        ))

    assert error.value.status_code == 409


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
