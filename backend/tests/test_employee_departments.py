import asyncio

import pytest
from fastapi import HTTPException

import server


def test_departments_combine_saved_company_departments_with_employee_departments(monkeypatch):
    async def fake_listall(collection, sort=None):
        if collection == "departments":
            return [{"name": "Packing"}, {"name": "Sales"}]
        if collection == "employees":
            return [
                {"name": "Alex", "department": "Packing"},
                {"name": "Sam", "department": "Production"},
                {"name": "Taylor", "department": ""},
            ]
        raise AssertionError(f"Unexpected collection: {collection}")

    monkeypatch.setattr(server, "listall", fake_listall)

    departments = asyncio.run(server.get_departments(user={"company_id": "iqfoam-whole-sallers"}))

    assert departments == ["Packing", "Production", "Sales"]


def test_add_department_reuses_existing_name_ignoring_case(monkeypatch):
    existing = {"id": "department-1", "name": "Packing"}

    async def fake_listall(_collection):
        return [existing]

    async def unexpected_insert(*_args, **_kwargs):
        raise AssertionError("An existing department should not be inserted again")

    monkeypatch.setattr(server, "listall", fake_listall)
    monkeypatch.setattr(server, "insert", unexpected_insert)
    monkeypatch.setattr(server, "require_admin", lambda _user: None)

    result = asyncio.run(server.add_department(
        server.DepartmentIn(name=" packing "),
        user={"role": "admin"},
    ))

    assert result == existing


def test_add_department_persists_a_new_department_for_the_active_company(monkeypatch):
    inserted = {}

    async def no_departments(_collection):
        return []

    async def capture_insert(collection, values):
        inserted.update(collection=collection, values=values)
        return {"id": "department-2", **values}

    monkeypatch.setattr(server, "listall", no_departments)
    monkeypatch.setattr(server, "insert", capture_insert)
    monkeypatch.setattr(server, "require_admin", lambda _user: None)

    result = asyncio.run(server.add_department(
        server.DepartmentIn(name="Finishing"),
        user={"role": "admin"},
    ))

    assert result == {"id": "department-2", "name": "Finishing"}
    assert inserted == {"collection": "departments", "values": {"name": "Finishing"}}


def test_department_name_is_required_and_limited_to_100_characters():
    with pytest.raises(ValueError):
        server.DepartmentIn(name="  ")
    with pytest.raises(ValueError):
        server.DepartmentIn(name="D" * 101)
    assert server.DepartmentIn(name="  Packing  ").name == "Packing"


def test_general_workers_are_restricted_to_iqfoam_wholesalers():
    employee = server.EmployeeIn(name="Worker", department="", is_general_worker=True)

    server.validate_employee_worker_type(employee, {"company_id": "iqfoam-whole-sallers"})

    with pytest.raises(HTTPException) as error:
        server.validate_employee_worker_type(employee, {"company_id": "superiqfoam"})
    assert error.value.status_code == 400
