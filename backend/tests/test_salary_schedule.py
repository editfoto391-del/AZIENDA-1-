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
