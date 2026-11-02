from datetime import date
import asyncio

import pytest
from fastapi import HTTPException

import server


@pytest.mark.parametrize(
    ("period", "value", "expected_start", "expected_end"),
    [
        ("weekly", "2026-10-31", date(2026, 10, 26), date(2026, 11, 1)),
        ("monthly", "2024-02", date(2024, 2, 1), date(2024, 2, 29)),
        ("monthly", "2026-10", date(2026, 10, 1), date(2026, 10, 31)),
    ],
)
def test_financial_period_ranges(period, value, expected_start, expected_end):
    assert server.financial_period_range(period, value) == (expected_start, expected_end)

@pytest.mark.parametrize(
    ("period", "start", "end", "expected_start", "expected_end"),
    [
        ("monthly", date(2026, 10, 1), date(2026, 10, 31), date(2026, 9, 1), date(2026, 9, 30)),
        ("monthly", date(2024, 3, 1), date(2024, 3, 31), date(2024, 2, 1), date(2024, 2, 29)),
        ("weekly", date(2026, 10, 26), date(2026, 11, 1), date(2026, 10, 19), date(2026, 10, 25)),
    ],
)
def test_financial_previous_period_ranges(period, start, end, expected_start, expected_end):
    assert server.financial_previous_period_range(period, start, end) == (
        expected_start,
        expected_end,
    )


@pytest.mark.parametrize(
    ("period", "value"),
    [("weekly", "2026-02-30"), ("monthly", "2026-13"), ("yearly", "2026-01")],
)
def test_financial_period_rejects_invalid_values(period, value):
    with pytest.raises(HTTPException):
        server.financial_period_range(period, value)

def test_financial_report_company_filter_obeys_existing_company_access():
    user = {
        "id": "worker-1",
        "is_worker": True,
        "company_roles": {"iqfoam-manufactoring": "user"},
    }
    assert server.financial_report_company(user, "iqfoam-manufactoring") == "iqfoam-manufactoring"
    with pytest.raises(HTTPException) as error:
        server.financial_report_company(user, "iqfoam-whole-sallers")
    assert error.value.status_code == 403

def test_financial_record_dates_use_the_company_reporting_timezone():
    assert server.financial_record_date(
        {"date": "2026-10-31T23:30:00+00:00"},
    ) == date(2026, 11, 1)

def test_dashboard_period_ranges_include_full_previous_month_and_custom_bounds(monkeypatch):
    monkeypatch.setattr(server, "local_today", lambda: date(2026, 11, 30))
    assert server.dashboard_period_ranges("month") == (
        ("2026-11-01", "2026-11-30"),
        ("2026-10-01", "2026-10-31"),
    )
    assert server.dashboard_period_ranges(
        "custom", "2026-11-01", "2026-11-30",
    ) == (
        ("2026-11-01", "2026-11-30"),
        ("2026-10-02", "2026-10-31"),
    )

def test_dashboard_custom_period_rejects_reversed_and_invalid_dates():
    with pytest.raises(HTTPException):
        server.dashboard_period_ranges("custom", "2026-11-30", "2026-11-01")
    with pytest.raises(HTTPException):
        server.dashboard_period_ranges("custom", "2026-02-30", "2026-03-01")

@pytest.mark.parametrize(
    ("period", "expected"),
    [
        ("today", (("2026-03-04", "2026-03-04"), ("2026-03-03", "2026-03-03"))),
        ("week", (("2026-03-02", "2026-03-04"), ("2026-02-23", "2026-02-25"))),
        ("month", (("2026-03-01", "2026-03-04"), ("2026-02-01", "2026-02-04"))),
        ("year", (("2026-01-01", "2026-03-04"), ("2025-01-01", "2025-03-04"))),
    ],
)
def test_dashboard_standard_period_ranges_use_equivalent_local_date_windows(
    monkeypatch, period, expected,
):
    monkeypatch.setattr(server, "local_today", lambda: date(2026, 3, 4))
    assert server.dashboard_period_ranges(period) == expected

def test_dashboard_completed_orders_counts_only_unique_orders_in_selected_period(monkeypatch):
    async def period_records(collection, start, end, date_field, conditions):
        assert collection == "orders"
        assert (start, end) == (date(2026, 3, 1), date(2026, 3, 4))
        assert date_field == "completed_at"
        assert conditions["status"] == "Delivered"
        return [{"id": "order-1"}, {"id": "order-1"}, {"id": "order-2"}, {}]

    monkeypatch.setattr(server, "financial_period_records", period_records)
    assert asyncio.run(server.dashboard_completed_orders_in_period("2026-03-01", "2026-03-04")) == 2

def test_dashboard_compare_returns_all_five_financial_metrics(monkeypatch):
    async def financial_period(start, end):
        return {
            "total_invoiced": 100,
            "revenue": 60,
            "buyings": 10,
            "expenses": 5,
            "profit": 45,
        }

    monkeypatch.setattr(server, "dashboard_financial_period", financial_period)
    result = asyncio.run(server.compare_dashboard_periods(
        "month", "2024-02", "2024-03", user={},
    ))

    assert (result["first"]["start"], result["first"]["end"]) == (
        "2024-02-01", "2024-02-29",
    )
    assert (result["second"]["start"], result["second"]["end"]) == (
        "2024-03-01", "2024-03-31",
    )
    for period_result in (result["first"], result["second"]):
        assert {
            key: period_result[key]
            for key in ("total_invoiced", "revenue", "buyings", "expenses", "profit")
        } == {
            "total_invoiced": 100,
            "revenue": 60,
            "buyings": 10,
            "expenses": 5,
            "profit": 45,
        }


def report_data(mode):
    start, end = date(2026, 10, 26), date(2026, 11, 1)
    return server.build_financial_report(
        start,
        end,
        mode,
        invoices=[
            {
                "id": "invoice-known", "number": "100", "date": "2026-10-27",
                "status": "issued", "total": 200, "amount_paid": 0,
                "customer_name": "Customer A",
                "items": [{"qty": 2, "category": "Foam", "size": "1x1"}],
            },
            {
                "id": "invoice-unknown", "number": "101", "date": "2026-10-28",
                "status": "issued", "total": 100, "amount_paid": 0,
                "customer_name": "Customer B", "items": [{"qty": 1}],
            },
            {"id": "draft", "number": None, "date": "2026-10-28", "status": "draft", "total": 999},
            {"id": "void", "number": "102", "date": "2026-10-28", "status": "void", "total": 999},
        ],
        payments=[
            {
                "id": "payment-active", "invoice_id": "invoice-known",
                "invoice_number": "100", "customer_name": "Customer A",
                "date": "2026-10-29", "amount": 25, "method": "Cash",
            },
            {"id": "payment-reversed", "invoice_id": "invoice-known", "date": "2026-10-29", "amount": 90, "reversed": True},
        ],
        linked_payments=[
            {
                "id": "payment-old", "invoice_id": "invoice-known",
                "date": "2026-10-20", "created_at": "2026-10-20T09:00:00",
                "amount": 25, "method": "Bank Transfer",
            },
            {
                "id": "payment-active", "invoice_id": "invoice-known",
                "date": "2026-10-29", "created_at": "2026-10-29T09:00:00",
                "amount": 25, "method": "Cash",
            },
            {"invoice_id": "invoice-known", "amount": 90, "reversed": True},
        ],
        expenses=[
            {"id": "expense", "date": "2026-10-30", "category": "Fuel", "amount": 10},
            {"id": "void-expense", "date": "2026-10-30", "amount": 999, "voided": True},
        ],
        vehicle_records=[
            {"id": "vehicle-cost", "date": "2026-10-30", "status": "Done", "amount": 5},
            {"id": "unfinished-repair", "date": "2026-10-30", "status": "Needed", "amount": 500},
        ],
        buyings=[
            {"id": "buying", "date": "2026-10-30", "item_type": "raw_material", "amount": 70},
            {"id": "void-buying", "date": "2026-10-30", "amount": 999, "voided": True},
        ],
        grvs=[
            {
                "id": "grv", "received_date": "2026-10-31", "status": "completed",
                "grv_number": "GRV-1", "items": [{"accepted_quantity": 3, "unit_cost": 10, "total_value": 30}],
            },
            {"id": "reversed-grv", "received_date": "2026-10-31", "status": "cancelled", "items": [{"total_value": 999}]},
        ],
        invoice_movements=[
            {
                "invoice_id": "invoice-known", "type": "invoice", "quantity": 2,
                "batch_allocations": [
                    {"batch_id": "batch-1", "quantity": 1, "unit_cost": 20, "cost_status": "verified"},
                    {"batch_id": "batch-2", "quantity": 1, "unit_cost": 40, "cost_status": "verified"},
                ],
            },
        ],
    )


def test_expenses_only_uses_accrual_sales_and_does_not_double_count_inventory():
    report = report_data("expenses_only")
    summary = report["summary"]
    assert summary["total_invoices"] == 300
    assert summary["payments_received"] == 25
    assert summary["pending_payments"] == 250
    assert summary["expenses"] == 15
    assert summary["buyings"] == 70
    assert summary["grv"] == 30
    assert summary["cogs"] is None
    assert summary["final_profit"] == 285
    assert summary["historical_cost_unavailable_count"] == 1
    assert [row["id"] for row in report["transactions"]["invoices"]] == [
        "invoice-known", "invoice-unknown",
    ]
    invoice = report["transactions"]["invoices"][0]
    assert invoice["customer_name"] == "Customer A"
    assert invoice["number"] == "100"
    assert invoice["amount_paid"] == 50
    assert invoice["balance_remaining"] == 150
    assert [
        (payment["date"], payment["method"], payment["amount"], payment["balance_remaining"])
        for payment in invoice["payment_records"]
    ] == [
        ("2026-10-20", "Bank Transfer", 25, 175),
        ("2026-10-29", "Cash", 25, 150),
    ]
    period_payment = report["transactions"]["payments"][0]
    assert period_payment["invoice_number"] == "100"
    assert period_payment["customer_name"] == "Customer A"
    assert period_payment["method"] == "Cash"
    assert period_payment["balance_remaining"] == 150


def test_payment_report_links_payment_to_invoice_outside_period_and_shows_remaining_balance():
    report = server.build_financial_report(
        date(2026, 10, 26),
        date(2026, 11, 1),
        "expenses_only",
        invoices=[],
        payments=[{
            "id": "payment-current", "invoice_id": "invoice-prior",
            "date": "2026-10-30", "amount": 40, "method": "Bank Transfer",
        }],
        linked_payments=[
            {
                "id": "payment-before", "invoice_id": "invoice-prior",
                "date": "2026-10-15", "amount": 20,
            },
            {
                "id": "payment-current", "invoice_id": "invoice-prior",
                "date": "2026-10-30", "amount": 40,
            },
        ],
        expenses=[],
        vehicle_records=[],
        buyings=[],
        grvs=[],
        invoice_movements=[],
        payment_invoices=[{
            "id": "invoice-prior", "number": "OLD-100",
            "customer_name": "Customer from previous month", "total": 100,
            "items": [{"description": "Foam", "qty": 1}],
        }],
    )
    payment = report["transactions"]["payments"][0]
    assert payment["invoice_number"] == "OLD-100"
    assert payment["customer_name"] == "Customer from previous month"
    assert payment["invoice_total"] == 100
    assert payment["balance_remaining"] == 40
    assert payment["invoice_items"] == [{"description": "Foam", "qty": 1}]


def test_full_production_cost_never_fills_missing_cost_from_current_stock():
    report = report_data("full_production_cost")
    summary = report["summary"]
    assert summary["known_cogs"] == 60
    assert summary["cogs"] is None
    assert summary["gross_profit"] is None
    assert summary["final_profit"] is None
    missing = report["transactions"]["historical_cost_unavailable"]
    assert len(missing) == 1
    assert missing[0]["id"] == "invoice-unknown"
    assert missing[0]["status"] == "Historical Cost Unavailable"
    assert report["daily"][1]["final_profit"] is None


def test_full_cost_rejects_partial_or_missing_batch_allocation():
    full = report_data("full_production_cost")
    inputs = {
        "invoices": [{"id": "invoice-1", "number": "1", "date": "2026-10-27", "status": "issued", "total": 20, "items": []}],
        "payments": [], "linked_payments": [], "expenses": [], "vehicle_records": [],
        "buyings": [], "grvs": [],
        "invoice_movements": [{"invoice_id": "invoice-1", "type": "invoice", "quantity": 2,
                               "batch_allocations": [{"quantity": 1, "unit_cost": 3}]}],
    }
    report = server.build_financial_report(date(2026, 10, 26), date(2026, 11, 1), "full_production_cost", **inputs)
    assert report["summary"]["final_profit"] is None
    assert report["summary"]["historical_cost_unavailable_count"] == 1
    assert full["summary"]["final_profit"] is None


def test_fifo_stock_cost_allocation_uses_receipt_cost_not_current_stock_cost():
    allocations = server.allocate_fifo_batches(
        "stock-1",
        2,
        [
            {
                "id": "grv-movement", "type": "purchase", "direction": 1,
                "quantity": 3, "unit_cost": 5.15,
                "batch_id": "grv:1:stock-1", "historical_cost_status": "verified",
                "created_at": "2026-10-27T09:00:00+00:00",
            },
        ],
        4,
    )
    assert allocations == [
        {
            "batch_id": "opening:stock-1", "quantity": 2.0,
            "unit_cost": None, "cost_status": "unavailable",
            "source_type": "opening_stock", "source_date": None,
            "grv_id": None, "production_id": None,
        },
        {
            "batch_id": "grv:1:stock-1", "quantity": 2.0,
            "unit_cost": 5.15, "cost_status": "verified",
            "source_type": "purchase", "source_date": None,
            "grv_id": None, "production_id": None,
        },
    ]


def test_fifo_allocations_account_for_prior_sales_and_unknown_opening_stock():
    allocations = server.allocate_fifo_batches(
        "stock-1",
        0,
        [
            {
                "id": "grv-1", "type": "purchase", "direction": 1,
                "quantity": 10, "unit_cost": 10, "batch_id": "batch-1",
                "historical_cost_status": "verified", "created_at": "2026-10-27",
            },
            {
                "id": "sale-1", "type": "invoice", "direction": -1,
                "quantity": 4,
                "batch_allocations": [{
                    "batch_id": "batch-1", "quantity": 4, "unit_cost": 10,
                    "cost_status": "verified",
                }],
                "created_at": "2026-10-28",
            },
        ],
        7,
    )
    assert [(row["quantity"], row["cost_status"]) for row in allocations] == [
        (6.0, "verified"), (1.0, "unavailable"),
    ]

def test_invoice_return_allocation_restores_the_original_batch_cost(monkeypatch):
    movements = [
        {
            "id": "sale", "invoice_id": "invoice-1", "stock_id": "stock-1",
            "type": "invoice", "direction": -1, "quantity": 3,
            "created_at": "2026-10-01",
            "batch_allocations": [
                {"batch_id": "batch-1", "quantity": 2, "unit_cost": 10, "cost_status": "verified"},
                {"batch_id": "batch-2", "quantity": 1, "unit_cost": 20, "cost_status": "verified"},
            ],
        },
        {
            "id": "return", "invoice_id": "invoice-1", "stock_id": "stock-1",
            "type": "invoice", "direction": 1, "quantity": 1,
            "created_at": "2026-10-02",
            "batch_allocations": [
                {"batch_id": "batch-2", "quantity": 1, "unit_cost": 20, "cost_status": "verified"},
            ],
        },
    ]

    async def find_movements(_collection, query):
        return [
            item for item in movements
            if item["invoice_id"] == query["invoice_id"] and item["stock_id"] == query["stock_id"]
        ]

    monkeypatch.setattr(server, "listall", find_movements)
    restored = asyncio.run(server.invoice_return_batch_allocations("invoice-1", "stock-1", 1))
    assert restored == [{
        "batch_id": "batch-1", "quantity": 1.0, "unit_cost": 10,
        "cost_status": "verified", "source_type": "", "source_date": None,
        "grv_id": None, "production_id": None,
    }]


def test_edited_invoice_cogs_nets_returned_batch_allocations():
    report = server.build_financial_report(
        date(2026, 10, 26), date(2026, 11, 1), "full_production_cost",
        invoices=[{
            "id": "invoice-edit", "number": "10", "date": "2026-10-27",
            "status": "issued", "total": 100, "items": [],
        }],
        payments=[], linked_payments=[], expenses=[], vehicle_records=[],
        buyings=[], grvs=[],
        invoice_movements=[
            {
                "invoice_id": "invoice-edit", "stock_id": "stock-1",
                "type": "invoice", "direction": -1, "quantity": 5,
                "batch_allocations": [{
                    "batch_id": "batch-1", "quantity": 5, "unit_cost": 10,
                    "cost_status": "verified",
                }],
            },
            {
                "invoice_id": "invoice-edit", "stock_id": "stock-1",
                "type": "invoice", "direction": 1, "quantity": 2,
                "batch_allocations": [{
                    "batch_id": "batch-1", "quantity": 2, "unit_cost": 10,
                    "cost_status": "verified",
                }],
            },
        ],
    )
    assert report["summary"]["cogs"] == 30
    assert report["summary"]["final_profit"] == 70
