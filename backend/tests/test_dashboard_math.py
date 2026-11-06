import asyncio
from datetime import date

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


def test_stock_movements_are_loaded_in_one_batched_query(monkeypatch):
    class Cursor:
        def __aiter__(self):
            return self.movements()

        async def movements(self):
            yield {"stock_id": "stock-a", "type": "purchase", "quantity": 3, "created_at": "2026-10-28"}
            yield {"stock_id": "stock-b", "type": "invoice", "quantity": 2, "created_at": "2026-10-29"}

    class Collection:
        def __init__(self):
            self.queries = []

        def find(self, query, projection):
            self.queries.append((query, projection))
            return Cursor()

    movements = Collection()
    monkeypatch.setattr(server, "db", type("Database", (), {"stock_movements": movements})())

    result = asyncio.run(server.stock_movements_for_stock_ids(["stock-a", "stock-b"]))

    assert len(movements.queries) == 1
    assert movements.queries[0][0] == {"stock_id": {"$in": ["stock-a", "stock-b"]}}
    assert result["stock-a"][0]["quantity"] == 3
    assert result["stock-b"][0]["type"] == "invoice"


def test_stock_batch_query_respects_each_active_company(monkeypatch):
    class Cursor:
        def __init__(self, documents):
            self.documents = documents

        def sort(self, field, direction):
            self.documents.sort(key=lambda item: item.get(field), reverse=direction < 0)
            return self

        async def to_list(self, limit):
            return self.documents[:limit]

        def __aiter__(self):
            async def documents():
                for document in self.documents:
                    yield document
            return documents()

    class Collection:
        def __init__(self, documents):
            self.documents = documents
            self.queries = []

        def find(self, query, projection):
            self.queries.append(query)

            def matches(document, condition):
                if "$and" in condition:
                    return all(matches(document, part) for part in condition["$and"])
                return all(
                    document.get(key) in value["$in"] if isinstance(value, dict) and "$in" in value
                    else document.get(key) == value
                    for key, value in condition.items()
                )

            return Cursor([document for document in self.documents if matches(document, query)])

    class Database:
        def __init__(self, name, company_id, amount):
            self.name = name
            self.stock = Collection([{
                "id": f"stock-{company_id}", "company_id": company_id,
                "product": company_id, "opening": 10,
            }])
            self.stock_movements = Collection([{
                "stock_id": f"stock-{company_id}", "company_id": company_id,
                "type": "purchase", "quantity": amount, "created_at": "2026-10-28",
            }])

        def __getitem__(self, name):
            return getattr(self, name)

    class Client:
        def __init__(self, databases):
            self.databases = databases

        def __getitem__(self, name):
            return self.databases[name]

    company_amounts = {
        "superiqfoam": 1,
        "iqfoam-manufactoring": 2,
        "iqfoam-whole-sallers": 3,
    }
    databases = {
        "base": Database("base", "superiqfoam", company_amounts["superiqfoam"]),
        **{
            f"base__{company_id}": Database(f"base__{company_id}", company_id, amount)
            for company_id, amount in company_amounts.items()
            if company_id != "superiqfoam"
        },
    }
    monkeypatch.setattr(server, "db", server.ScopedDatabase(Client(databases), databases["base"]))

    for company_id, amount in company_amounts.items():
        token = server.active_company_id.set(company_id)
        try:
            stocks = asyncio.run(server.get_stock({"_active_company_id": company_id}))
        finally:
            server.active_company_id.reset(token)

        assert [(stock["id"], stock["current"]) for stock in stocks] == [
            (f"stock-{company_id}", 10 + amount)
        ]


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
        grvs=[
            {
                "id": "grv-accepted", "received_date": "2026-10-13",
                "status": "partially_received",
                "items": [{"accepted_quantity": 3, "unit_cost": 10, "total_value": 30}],
            },
            {
                "id": "grv-reversed", "received_date": "2026-10-14",
                "status": "cancelled", "items": [{"total_value": 999}],
            },
            {
                "id": "grv-draft", "received_date": "2026-10-14",
                "status": "draft", "items": [{"total_value": 999}],
            },
        ],
        salaries=10,
    )

    assert result["revenue"] == 100
    assert result["expenses"] == 50
    assert result["buyings"] == 40
    assert result["grv_expenses"] == 30
    assert result["salaries"] == 10
    assert result["profit"] == -30
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
        grvs=[],
    )

    assert result["revenue"] == 100
    assert result["expenses"] == 25
    assert result["profit"] == 75


def test_salary_cost_for_period_prorates_monthly_fixed_pay(monkeypatch):
    async def salary_report(start_date, end_date):
        assert (start_date, end_date) == ("2026-01-16", "2026-01-31")
        return {"employees": [
            {"pay_frequency": "monthly_fixed", "monthly_salary": 3100, "gross_salary": 0},
            {"pay_frequency": "weekly_fixed", "gross_salary": 120},
        ]}

    monkeypatch.setattr(server, "salary_report", salary_report)
    assert asyncio.run(server.salary_cost_for_period("2026-01-16", "2026-01-31")) == 1720


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
        grvs=[{
            "id": "grv-1", "received_date": "2026-10-31", "status": "completed",
            "items": [{"accepted_quantity": 2, "unit_cost": 100, "total_value": 200}],
        }],
        salaries=500,
    )

    assert totals["total_invoiced"] == 100000
    assert totals["revenue"] == 60000
    assert totals["buyings"] == 10000
    assert totals["grv_expenses"] == 200
    assert totals["salaries"] == 500
    assert totals["expenses"] == 5000
    assert totals["profit"] == 44300
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
        grvs=[],
    )
    assert {key: totals[key] for key in ("total_invoiced", "revenue", "buyings", "grv_expenses", "salaries", "expenses", "profit")} == {
        "total_invoiced": 0,
        "revenue": 0,
        "buyings": 0,
        "grv_expenses": 0,
        "salaries": 0,
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
        grvs=[],
    )
    assert totals["total_invoiced"] == 1.01
    assert totals["revenue"] == 0.34
    assert totals["expenses"] == 0.11
    assert totals["buyings"] == 0.11
    assert totals["profit"] == 0.12


def test_dashboard_financial_totals_counts_standard_invoices_and_all_payment_sections():
    totals = dashboard_financial_totals(
        "2026-10-01",
        "2026-10-31",
        invoices=[
            {"id": "standard", "number": "100", "date": "2026-10-01", "total": 100},
            {"id": "express", "number": "EW-100", "date": "2026-10-01", "total": 400, "invoice_type": "express"},
        ],
        payments=[
            {"id": "standard-payment", "date": "2026-10-02", "amount": 10},
            {"id": "express-payment", "date": "2026-10-02", "amount": 20},
        ],
        expenses=[],
        vehicle_records=[],
        buyings=[],
    )

    assert totals["total_invoiced"] == 100
    assert totals["revenue"] == 30


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
        customers = Collection()

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
    total_invoiced_condition = captured[0][3]["$group"]["total_invoiced"]["$sum"]["$cond"][0]["$and"]
    assert total_invoiced_condition[1] == {
        "$ne": [{"$ifNull": ["$invoice_type", "standard"]}, "express"],
    }


def test_dashboard_all_time_outstanding_includes_both_customer_balance_sections(monkeypatch):
    class Cursor:
        def __init__(self, rows):
            self.rows = rows

        async def to_list(self, limit):
            return self.rows

    class Collection:
        def __init__(self, rows):
            self.rows = rows

        def aggregate(self, pipeline):
            return Cursor(self.rows)

    class Database:
        invoices = Collection([{"total_invoiced": 100, "outstanding": 200, "overdue": 50}])
        customers = Collection([{"total": 200}])

    monkeypatch.setattr(server, "db", Database())

    result = asyncio.run(server.dashboard_all_time_invoice_totals("2026-11-01"))

    assert result == {"total_invoiced": 100, "outstanding": 400, "overdue": 50}


def test_dashboard_financial_periods_load_overlapping_periods_once(monkeypatch):
    calls = []
    records = {
        "invoices": [
            {"id": "invoice-1", "number": "100", "date": "2026-03-02", "total": 100},
        ],
        "payments": [{"id": "payment-1", "date": "2026-03-03", "amount": 40}],
        "expenses": [],
        "vehicle_records": [],
        "buyings": [],
        "grvs": [{
            "id": "grv-1", "received_date": "2026-03-03", "status": "completed",
            "items": [{"accepted_quantity": 2, "unit_cost": 6, "total_value": 12}],
        }],
    }

    async def period_records(collection, start, end, date_field="date", conditions=None):
        calls.append((collection, start, end, date_field, conditions))
        return records[collection]

    monkeypatch.setattr(server, "financial_period_records", period_records)
    async def salary_cost(_start, _end):
        return 5

    monkeypatch.setattr(server, "salary_cost_for_period", salary_cost)
    periods = [
        ("2026-03-02", "2026-03-04"),
        ("2026-03-01", "2026-03-04"),
        ("2026-02-23", "2026-02-25"),
        ("2026-02-01", "2026-02-04"),
        ("2026-03-02", "2026-03-04"),
    ]

    result = asyncio.run(server.dashboard_financial_periods(periods))

    assert len(calls) == 6
    assert {(call[1], call[2]) for call in calls} == {
        (date(2026, 2, 1), date(2026, 3, 4)),
    }
    assert result[("2026-03-02", "2026-03-04")]["total_invoiced"] == 100
    assert result[("2026-03-02", "2026-03-04")]["grv_expenses"] == 12
    assert result[("2026-03-02", "2026-03-04")]["salaries"] == 5
    assert result[("2026-03-02", "2026-03-04")]["profit"] == 23
    assert result[("2026-02-23", "2026-02-25")]["total_invoiced"] == 0
