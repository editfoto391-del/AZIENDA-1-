import asyncio
from types import SimpleNamespace

import server


def test_delivery_fee_is_added_after_discount_without_changing_existing_charge_rules():
    invoice = server.compute_invoice({
        "items": [{"qty": 1, "unit_price": 1000}],
        "discount": 100,
        "extra_charges": 0,
        "delivery_fee": 50,
        "tax_enabled": False,
        "amount_paid": 0,
    })

    assert invoice["subtotal"] == 1000
    assert invoice["total"] == 950
    assert invoice["outstanding"] == 950


def test_historical_invoice_without_delivery_fee_keeps_existing_total():
    invoice = server.compute_invoice({
        "items": [{"qty": 2, "unit_price": 500}],
        "discount": 100,
        "extra_charges": 25,
        "tax_enabled": False,
        "amount_paid": 0,
    })

    assert invoice["total"] == 925


def test_delivery_fee_is_included_in_taxable_amount_using_existing_tax_rules():
    invoice = server.compute_invoice({
        "items": [{"qty": 1, "unit_price": 1000}],
        "discount": 100,
        "delivery_fee": 50,
        "tax_enabled": True,
        "tax_rate": 15,
        "amount_paid": 0,
    })

    assert invoice["tax_amount"] == 142.5
    assert invoice["total"] == 1092.5


def test_invoice_can_choose_whether_to_show_previous_balance():
    assert server.InvoiceIn().include_previous_balance is True
    assert server.InvoiceIn(include_previous_balance=False).include_previous_balance is False


def test_customer_balance_combines_all_invoice_sections_and_other_balance(monkeypatch):
    class Cursor:
        def __init__(self, records):
            self.records = records

        async def to_list(self, _limit):
            return [dict(record) for record in self.records]

    class InvoiceCollection:
        def find(self, query, _projection):
            records = [
                invoice for invoice in invoices
                if invoice["customer_id"] == query["customer_id"]
                and invoice.get("archived") is not True
                and invoice.get("status") not in query["status"]["$nin"]
                and invoice["id"] != query.get("id", {}).get("$ne")
            ]
            return Cursor(records)

    class CustomerCollection:
        async def find_one(self, query, _projection):
            return {"other_balance": 20.25} if query["id"] == "customer-1" else None

    invoices = [
        {"id": "standard", "customer_id": "customer-1", "invoice_type": "standard",
         "status": "issued", "items": [{"qty": 1, "unit_price": 100}], "amount_paid": 25},
        {"id": "express", "customer_id": "customer-1", "invoice_type": "express",
         "status": "issued", "items": [{"qty": 1, "unit_price": 60}], "amount_paid": 10},
        {"id": "draft", "customer_id": "customer-1", "status": "draft",
         "items": [{"qty": 1, "unit_price": 500}], "amount_paid": 0},
        {"id": "void", "customer_id": "customer-1", "status": "void",
         "items": [{"qty": 1, "unit_price": 300}], "amount_paid": 0},
        {"id": "archived", "customer_id": "customer-1", "status": "issued",
         "archived": True, "items": [{"qty": 1, "unit_price": 200}], "amount_paid": 0},
    ]
    monkeypatch.setattr(server, "db", SimpleNamespace(
        invoices=InvoiceCollection(),
        customers=CustomerCollection(),
    ))

    total = asyncio.run(server.customer_balance_before_invoice("customer-1"))
    excluding_express = asyncio.run(server.customer_balance_before_invoice("customer-1", "express"))

    assert total == 145.25
    assert excluding_express == 95.25


def test_new_invoice_records_submitted_preparer_and_authenticated_user_and_delivery_fee():
    body = server.InvoiceIn(
        customer_name="Synthetic Customer",
        items=[{"qty": 1, "unit_price": 1000}],
        discount=100,
        delivery_fee=50,
        made_by="Manual Invoice Preparer",
    )

    invoice = asyncio.run(server._prepare_invoice(
        body,
        user={"id": "test-user", "name": "Synthetic User"},
    ))

    assert invoice["made_by"] == "Manual Invoice Preparer"
    assert invoice["made_by_user_id"] == "test-user"
    assert invoice["total"] == 950


def test_new_invoice_requires_a_manually_submitted_preparer():
    body = server.InvoiceIn(
        customer_name="Synthetic Customer",
        items=[{"qty": 1, "unit_price": 1000}],
    )

    try:
        asyncio.run(server._prepare_invoice(
            body,
            user={"id": "test-user", "name": "Synthetic User"},
        ))
    except server.HTTPException as error:
        assert error.status_code == 400
        assert error.detail == "Made By is required"
    else:
        raise AssertionError("Invoice creation should require a manually submitted preparer")


def test_invoice_submission_hash_changes_with_financial_data():
    base = server.InvoiceIn(customer_name="Synthetic Customer", delivery_fee=50, idempotency_key="request-1")
    changed = server.InvoiceIn(customer_name="Synthetic Customer", delivery_fee=51, idempotency_key="request-1")

    assert server.invoice_submission_hash(base) != server.invoice_submission_hash(changed)
