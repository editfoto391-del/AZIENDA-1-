import asyncio

import pytest
from fastapi import HTTPException

import server
import seed_data


@pytest.mark.parametrize(
    "endpoint",
    [server.import_employee_roster, server.reconcile_payroll_roster],
)
def test_payroll_roster_endpoints_reject_other_companies(monkeypatch, endpoint):
    monkeypatch.setattr(server, "require_admin", lambda _user: None)

    async def unexpected_reconciliation(_user):
        raise AssertionError("The Super IQ-Foam roster must not be reconciled for another company")

    monkeypatch.setattr(server, "reconcile_employee_roster", unexpected_reconciliation)

    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint(user={"_active_company_id": "iqfoam-whole-sallers"}))

    assert error.value.status_code == 403


def test_payroll_roster_remains_available_to_superiqfoam():
    server.validate_payroll_roster_company({"_active_company_id": "superiqfoam"})


def test_payroll_roster_matches_the_31_employees_in_the_supplied_image():
    roster = seed_data.EMPLOYEE_PAYROLL_ROSTER

    assert len(roster) == 31
    assert len({employee["name"].casefold() for employee in roster}) == 31
    assert all(employee["pay_type"] == "hourly" for employee in roster)
    assert {employee["department"] for employee in roster} == {
        "CHEMICAL",
        "COVER STITCHING",
        "FABRIC CUTTING",
        "TAILORING (TAPE EDGE)",
        "MATTRESS PACKING (PLASTING)",
        "MATTRESS COVERING AND LOADING",
        "DRIVING",
        "SECURITY",
    }
    assert sum(employee["weekly_salary"] for employee in roster) == 30800
    assert all(employee["hours_per_week"] == 45 for employee in roster)
    assert not {employee["name"] for employee in roster} & {"AMEENA", "MR. YASEEN"}


def test_non_chemical_employees_also_use_the_45_hour_week():
    non_chemical = [
        employee for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER
        if employee["department"] != "CHEMICAL"
        and employee["name"] not in ("SHERIF", "ABDUL DRIVER", "BILAL", "SECURITY GUARD")
    ]

    assert all(employee["hours_per_week"] == 45 for employee in non_chemical)
    expected_salaries = {
        "CASSIM": 900,
        "NONTEMBISO": 900,
        "NTOSH": 1000,
        "ANELE FABRIC": 1000,
        "ANELE PLASTIC": 1000,
        "MNEH": 1000,
        "TMABANE": 800,
    }
    roster = {employee["name"]: employee for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER}
    assert {name: roster[name]["weekly_salary"] for name in expected_salaries} == expected_salaries
    assert roster["MNEH"]["department"] == "MATTRESS PACKING (PLASTING)"
    assert roster["TMABANE"]["department"] == "CHEMICAL"
    assert roster["LUNGHISANI"]["department"] == "CHEMICAL"
    assert seed_data.EMPLOYEE_PAYROLL_NAME_ALIASES == {
        "MINEH": "MNEH",
        "TMBANE": "TMABANE",
    }


def test_all_employees_use_the_six_day_45_hour_salary_schedule():
    chemical = [
        employee for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER
        if employee["department"] == "CHEMICAL"
    ]

    assert len(chemical) == 7
    assert all(employee["hours_per_week"] == 45 for employee in chemical)
    assert all(employee["hours_per_week"] == 45 for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER)


def test_security_guard_has_fixed_1000_weekly_salary_for_45_hours():
    security = next(
        employee for employee in seed_data.EMPLOYEE_PAYROLL_ROSTER
        if employee["name"] == "SECURITY GUARD"
    )

    assert security["department"] == "SECURITY"
    assert security["hours_per_week"] == 45
    assert security["weekly_salary"] == 1000
