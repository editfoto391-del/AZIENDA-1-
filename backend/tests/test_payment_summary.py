import asyncio

import pytest
from fastapi import HTTPException

import server


class FakeCursor:
    def __init__(self, records):
        self.records = records

    async def to_list(self, length):
        return self.records


class FakeInvoices:
    def __init__(self):
        self.records = [
            {"id": "standard-invoice", "number": "INV-1", "customer_name": "Standard Client"},
            {"id": "express-invoice", "number": "EXP-1", "customer_name": "Express Client", "invoice_type": "express"},
            {"id": "archived-invoice", "number": "INV-2", "customer_name": "Archived Client", "archived": True},
        ]

    def find(self, query, projection=None):
        invoice_ids = set(query["id"]["$in"])
        return FakeCursor([
            invoice for invoice in self.records
            if invoice["id"] in invoice_ids
            and invoice.get("invoice_type") != "express"
            and invoice.get("archived") is not True
        ])


class FakeDatabase:
    invoices = FakeInvoices()


def test_payment_summary_lists_standard_invoice_and_other_balance_payments(monkeypatch):
    payments = [
        {
            "id": "standard-payment", "invoice_id": "standard-invoice",
            "invoice_number": "INV-1", "amount": 100, "date": "2026-11-06",
        },
        {
            "id": "standard-other-balance", "other_balance_payment": True,
            "customer_name": "Old Balance Client", "amount": 25, "date": "2026-11-06",
        },
        {"id": "express-payment", "invoice_id": "express-invoice", "amount": 50},
        {"id": "archived-payment", "invoice_id": "archived-invoice", "amount": 10},
        {"id": "express-other-balance", "other_balance_payment": True, "express": True, "amount": 8},
    ]

    async def daily_records(collection, selected_date, conditions, sort_field):
        assert collection == "payments"
        assert selected_date == "2026-11-06"
        assert conditions["reversed"] == {"$ne": True}
        assert sort_field == "created_at"
        return payments

    monkeypatch.setattr(server, "daily_report_records", daily_records)
    monkeypatch.setattr(server, "db", FakeDatabase())

    result = asyncio.run(server.get_payments_summary("2026-11-06", user={}))

    assert [payment["id"] for payment in result] == [
        "standard-other-balance", "standard-payment",
    ]
    assert result[1]["customer_name"] == "Standard Client"
    assert result[1]["invoice_number"] == "INV-1"
    assert sum(payment["amount"] for payment in result) == 125


def test_payment_summary_rejects_invalid_date():
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_payments_summary("2026-02-30", user={}))

    assert error.value.status_code == 422
