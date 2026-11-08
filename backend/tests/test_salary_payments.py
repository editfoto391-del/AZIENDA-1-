import asyncio
from types import SimpleNamespace

import pytest

import server


class PaymentCollection:
    def __init__(self, existing=None):
        self.existing = existing
        self.queries = []

    async def find_one(self, query, _projection=None):
        self.queries.append(query)
        return self.existing


def install_payment_mocks(monkeypatch, employee, *, existing=None):
    collection = PaymentCollection(existing)
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(salary_payments=collection),
    )
    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    monkeypatch.setattr(
        server,
        "salary_report",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"employees": [employee]}),
    )
    inserted = {}

    async def insert_record(_collection, data):
        inserted.update(data)
        return {"id": "payment-1", **data}

    async def audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "insert", insert_record)
    monkeypatch.setattr(server, "log_audit", audit)
    return collection, inserted


def test_monthly_payment_records_exact_amount_and_owner_selected_date(monkeypatch):
    employee = {
        "employee_id": "yassine-id",
        "name": "Yassine Uncle",
        "department": "Management",
        "pay_frequency": "monthly_fixed",
        "gross_salary": 6500,
        "cut": 1200,
    }
    _, inserted = install_payment_mocks(monkeypatch, employee)

    result = asyncio.run(server.record_salary_payment(
        server.SalaryPaymentIn(
            employee_id="yassine-id",
            period_type="monthly",
            period_start="2026-11-01",
            period_end="2026-11-30",
            payment_date="2026-11-07",
        ),
        user={"id": "owner-1", "role": "admin"},
    ))

    assert result["payment_date"] == "2026-11-07"
    assert inserted["payroll_key"] == "monthly:2026-11"
    assert inserted["gross_amount"] == 6500
    assert inserted["deduction_amount"] == 1200
    assert inserted["net_amount"] == 5300


def test_duplicate_payment_is_rejected_without_inserting_another_record(monkeypatch):
    employee = {
        "employee_id": "ameena-id",
        "name": "Ameena",
        "pay_frequency": "monthly_fixed",
        "gross_salary": 9000,
        "cut": 0,
    }
    collection, inserted = install_payment_mocks(
        monkeypatch, employee, existing={"id": "already-paid"},
    )

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.record_salary_payment(
            server.SalaryPaymentIn(
                employee_id="ameena-id",
                period_type="monthly",
                period_start="2026-11-01",
                period_end="2026-11-30",
                payment_date="2026-11-15",
            ),
            user={"id": "owner-1", "role": "admin"},
        ))

    assert error.value.status_code == 409
    assert inserted == {}
    assert collection.queries[0]["payroll_key"] == "monthly:2026-11"


def test_monthly_payment_rejects_a_partial_calendar_month(monkeypatch):
    with pytest.raises(server.HTTPException) as error:
        server.salary_payroll_key("monthly", "2026-11-02", "2026-11-07")

    assert error.value.status_code == 400


def test_payment_date_must_be_a_real_calendar_date():
    with pytest.raises(ValueError):
        server.SalaryPaymentIn(
            employee_id="yassine-id",
            period_type="monthly",
            period_start="2026-11-01",
            period_end="2026-11-30",
            payment_date="2026-02-30",
        )
