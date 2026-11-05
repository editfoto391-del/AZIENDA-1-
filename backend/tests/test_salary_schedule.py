import asyncio
from types import SimpleNamespace

import server


class EmployeeCollection:
    def __init__(self, employee):
        self.employee = employee

    async def find_one(self, _query, _projection=None):
        return dict(self.employee)


def install_salary_update_mocks(monkeypatch, employee):
    database = SimpleNamespace(employees=EmployeeCollection(employee))
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "require_admin", lambda _user: None)

    async def update_doc(_collection, _employee_id, fields):
        employee.update(fields)
        return dict(employee)

    async def log_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", log_audit)


def test_saving_fixed_weekly_salary_always_uses_six_day_schedule(monkeypatch):
    employee = {"id": "employee-1", "hourly_rate": 20, "weekly_salary": 900, "hours_per_week": 45}
    install_salary_update_mocks(monkeypatch, employee)

    result = asyncio.run(server.save_salary_rate(
        "employee-1",
        server.SalaryRateIn(weekly_salary=1000),
        user={"role": "admin"},
    ))

    assert result["weekly_salary"] == 1000
    assert result["hours_per_week"] == 45
    assert result["work_days_per_week"] == 6
    assert result["hourly_rate"] == 20.833333


def test_saving_fixed_weekly_salary_uses_six_day_schedule(monkeypatch):
    employee = {"id": "employee-2", "hourly_rate": 20, "weekly_salary": 1000, "hours_per_week": 45}
    install_salary_update_mocks(monkeypatch, employee)

    result = asyncio.run(server.save_salary_rate(
        "employee-2",
        server.SalaryRateIn(weekly_salary=1200, work_days_per_week=6),
        user={"role": "admin"},
    ))

    assert result["weekly_salary"] == 1200
    assert result["hours_per_week"] == 45
    assert result["work_days_per_week"] == 6
    assert result["hourly_rate"] == 25


def test_saving_monthly_fixed_salary_does_not_change_weekly_salary(monkeypatch):
    employee = {
        "id": "employee-monthly",
        "name": "MR. YASEEN",
        "hourly_rate": 20,
        "weekly_salary": 1000,
    }
    install_salary_update_mocks(monkeypatch, employee)

    result = asyncio.run(server.save_salary_rate(
        "employee-monthly",
        server.SalaryRateIn(monthly_salary=12000),
        user={"role": "admin"},
    ))

    assert result["monthly_salary"] == 12000
    assert result["weekly_salary"] == 1000


def test_monthly_fixed_salary_cannot_be_set_for_weekly_employees(monkeypatch):
    employee = {"id": "employee-weekly", "name": "Yaseen", "weekly_salary": 1000}
    install_salary_update_mocks(monkeypatch, employee)

    try:
        asyncio.run(server.save_salary_rate(
            "employee-weekly",
            server.SalaryRateIn(monthly_salary=12000),
            user={"role": "admin"},
        ))
    except server.HTTPException as error:
        assert error.status_code == 422
    else:
        raise AssertionError("Expected monthly salary to be rejected for a weekly employee")


def test_monthly_fixed_salary_cut_requires_a_complete_month(monkeypatch):
    async def monthly_employee_report(_start_date, _end_date):
        return {"employees": [{
            "employee_id": "employee-monthly",
            "pay_frequency": "monthly_fixed",
            "is_full_month_period": False,
        }]}

    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    monkeypatch.setattr(server, "salary_report", monthly_employee_report)

    try:
        asyncio.run(server.save_salary_cut(
            server.SalaryCutIn(
                employee_id="employee-monthly",
                start_date="2026-10-26",
                end_date="2026-11-01",
                amount=100,
            ),
            user={"role": "admin"},
        ))
    except server.HTTPException as error:
        assert error.status_code == 400
    else:
        raise AssertionError("Expected a monthly salary cut to require a complete month")
