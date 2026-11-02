import asyncio

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
