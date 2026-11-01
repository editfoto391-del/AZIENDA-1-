import asyncio

import pytest

import server
from server import (
    apply_stock_movements,
    dashboard_financial_totals,
    invoice_outstanding_amount,
    profit_from_records,
)


def test_stock_dashboard_summary_matches_stock_movement_rules():
    stock = {"id": "stock-1", "opening": 10}
    movements = [
        {"type": "purchase", "quantity": 3, "created_at": "2026-10-28T10:00:00+00:00"},
        {"type": "invoice", "quantity": 2, "created_at": "2026-10-29T10:00:00+00:00"},
        {"type": "adjustment_in", "quantity": 1.5, "direction": 1, "created_at": "2026-10-29T11:00:00+00:00"},
        {"type": "production_consumption", "quantity": 4, "created_at": "2026-10-29T12:00:00+00:00"},
    ]

    result = apply_stock_movements(stock, movements)

    assert result["current"] == 8.5
    assert result["purchased"] == 3
    assert result["production_used"] == 4
    assert result["invoiced"] == 2
    assert result["adjustments"] == 1.5
    assert result["last_movement"] == "2026-10-29T12:00:00+00:00"


def test_dashboard_profit_uses_same_period_filters_and_excludes_reversed_payments():
    result = profit_from_records(
        "2026-10-01",
        "2026-10-31",
        payments=[
            {"date": "2026-10-05", "amount": 100},
            {"date": "2026-10-10", "amount": 250, "reversed": True},
            {"date": "2026-11-01", "amount": 400},
        ],
        expenses=[
            {"date": "2026-10-07", "amount": 30},
            {"date": "2026-09-30", "amount": 80},
        ],
        vehicle_records=[
            {"date": "2026-10-08", "status": "Done", "amount": 20},
            {"date": "2026-10-09", "status": "Scheduled", "amount": 999},
        ],
        buyings=[
            {"date": "2026-10-12", "amount": 40},
            {"date": "2026-11-01", "amount": 60},
        ],
    )

    assert result["revenue"] == 100
    assert result["expenses"] == 50
    assert result["buyings"] == 40
    assert result["profit"] == 10
    assert result["label"].startswith("Estimated result")


def test_dashboard_profit_filters_timestamp_records_by_local_company_date():
    result = profit_from_records(
        "2026-10-01",
        "2026-10-31",
        payments=[
            {"date": "2026-09-30T22:30:00+00:00", "amount": 100},
            {"date": "2026-10-31T22:30:00+00:00", "amount": 200},
        ],
        expenses=[{"date": "2026-10-31T21:59:00+00:00", "amount": 25}],
        vehicle_records=[],
        buyings=[],
    )

    assert result["revenue"] == 100
    assert result["expenses"] == 25
    assert result["profit"] == 75


def test_dashboard_financial_totals_deduplicate_and_separate_invoices_from_cash():
    invoices = [
        {"id": "fully-paid", "number": "A-1", "date": "2026-10-01", "total": 40000},
        {"id": "partial", "number": "A-2", "date": "2026-10-31", "total": 30000},
        {"id": "unpaid", "number": "A-3", "date": "2026-10-31", "total": 30000},
        {"id": "partial", "number": "A-2", "date": "2026-10-31", "total": 30000},
        {"id": "draft", "number": None, "date": "2026-10-15", "status": "draft", "total": 90000},
        {"id": "void", "number": "A-4", "date": "2026-10-15", "status": "void", "total": 90000},
        {"id": "opening", "number": "OB-1", "date": "2026-10-15", "opening_balance": True, "total": 90000},
        {"id": "next-period", "number": "A-5", "date": "2026-11-01", "total": 90000},
    ]
    payments = [
        {"id": "payment-1", "invoice_id": "fully-paid", "date": "2026-10-01", "amount": 40000},
        {"id": "payment-2", "invoice_id": "partial", "date": "2026-10-10", "amount": 12000},
        {"id": "payment-3", "invoice_id": "partial", "date": "2026-10-31T21:59:00+00:00", "amount": 8000},
        {"id": "payment-3", "invoice_id": "partial", "date": "2026-10-31T21:59:00+00:00", "amount": 8000},
        {"id": "reversed", "date": "2026-10-15", "amount": 99999, "reversed": True},
        {"id": "outside", "date": "2026-11-01", "amount": 99999},
    ]
    expenses = [
        {"id": "expense-a", "date": "2026-10-01", "amount": 2500},
        {"id": "expense-b", "date": "2026-10-31", "amount": 2500},
        {"id": "expense-b", "date": "2026-10-31", "amount": 2500},
        {"id": "void-expense", "date": "2026-10-15", "amount": 99999, "voided": True},
    ]
    buyings = [
        {"id": "buying-a", "date": "2026-10-01", "amount": 10000},
        {"id": "buying-a", "date": "2026-10-01", "amount": 10000},
        {"id": "void-buying", "date": "2026-10-15", "amount": 99999, "voided": True},
    ]

    totals = dashboard_financial_totals(
        "2026-10-01",
        "2026-10-31",
        invoices=invoices,
        payments=payments,
        expenses=expenses,
        vehicle_records=[],
        buyings=buyings,
    )

    assert totals["total_invoiced"] == 100000
    assert totals["revenue"] == 60000
    assert totals["buyings"] == 10000
    assert totals["expenses"] == 5000
    assert totals["profit"] == 45000
    invoice_balances = [
        invoice_outstanding_amount(invoices[0], 40000),
        invoice_outstanding_amount(invoices[1], 20000),
        invoice_outstanding_amount(invoices[2], 0),
    ]
    assert invoice_balances == [0, 10000, 30000]
    assert sum(invoice_balances) == 40000
    assert invoice_outstanding_amount(invoices[1], 40000) == 0


def test_dashboard_financial_totals_handle_empty_and_decimal_periods():
    totals = dashboard_financial_totals(
        "2026-10-01",
        "2026-10-31",
        invoices=[],
        payments=[],
        expenses=[],
        vehicle_records=[],
        buyings=[],
    )
    assert {key: totals[key] for key in ("total_invoiced", "revenue", "buyings", "expenses", "profit")} == {
        "total_invoiced": 0,
        "revenue": 0,
        "buyings": 0,
        "expenses": 0,
        "profit": 0,
    }

    totals = dashboard_financial_totals(
        "2026-10-01",
        "2026-10-31",
        invoices=[{"id": "decimal", "number": "A-1", "date": "2026-10-31", "total": 1.005}],
        payments=[{"id": "decimal-payment", "date": "2026-10-31", "amount": 0.335}],
        expenses=[{"id": "decimal-expense", "date": "2026-10-31", "amount": 0.105}],
        vehicle_records=[],
        buyings=[{"id": "decimal-buying", "date": "2026-10-31", "amount": 0.105}],
    )
    assert totals["total_invoiced"] == 1.01
    assert totals["revenue"] == 0.34
    assert totals["expenses"] == 0.11
    assert totals["buyings"] == 0.11
    assert totals["profit"] == 0.12


def test_dashboard_recent_invoice_balances_accept_invoice_records(monkeypatch):
    async def payment_totals(invoice_ids):
        assert invoice_ids == ["partial", "paid"]
        return {"partial": 40, "paid": 100}

    monkeypatch.setattr(server, "dashboard_payment_totals_by_invoice", payment_totals)
    invoices = [
        {"id": "partial", "number": "A-1", "total": 100},
        {"id": "paid", "number": "A-2", "total": 100},
        {"id": "draft", "number": None, "status": "draft", "total": 300},
        {"id": "void", "number": "A-3", "status": "void", "total": 400},
    ]

    balances = asyncio.run(server.dashboard_invoice_outstanding_by_id(invoices))

    assert balances == {"partial": 60, "paid": 0, "draft": 0, "void": 0}


@pytest.mark.parametrize(
    "company_id",
    ["superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers"],
)
def test_dashboard_outstanding_lookup_is_scoped_to_active_company(monkeypatch, company_id):
    captured = []

    class Cursor:
        async def to_list(self, limit):
            return []

    class Collection:
        def aggregate(self, pipeline):
            captured.append(pipeline)
            return Cursor()

    class Database:
        invoices = Collection()

    monkeypatch.setattr(server, "db", Database())
    token = server.active_company_id.set(company_id)
    try:
        result = asyncio.run(server.dashboard_all_time_invoice_totals("2026-11-01"))
    finally:
        server.active_company_id.reset(token)

    assert result == {"total_invoiced": 0, "outstanding": 0, "overdue": 0}
    payment_match = captured[0][1]["$lookup"]["pipeline"][0]["$match"]
    assert payment_match["company_id"] == company_id
    invoice_projection = captured[0][2]["$project"]
    assert invoice_projection["outstanding"]["$cond"][0]["$gt"][1] == 0
    overdue_condition = captured[0][3]["$group"]["overdue"]["$sum"]["$cond"][0]["$and"][0]
    assert overdue_condition["$lt"][0] == {
        "$ifNull": ["$due_date", "9999-12-31"],
    }
