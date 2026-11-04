import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server

MANUFACTURING = {"_active_company_id": server.MANUFACTURING_COMPANY_ID}


def test_chemical_log_requires_remaining_estimate_and_valid_quantities():
    ok = server.ChemicalLogIn(lines=[{"chemical": " Isocyanate ", "remaining_estimate": 120.5, "used_quantity": 10}])
    assert ok.lines[0].chemical == "Isocyanate"
    initial = server.ChemicalLogIn(lines=[{"chemical": "TDI", "initial_quantity": 500}])
    assert initial.lines[0].remaining_estimate == 500
    calc = server.ChemicalLogIn(lines=[{"chemical": "TDI", "initial_quantity": 500, "used_quantity": 120}])
    assert calc.lines[0].remaining_estimate == 380
    with pytest.raises(ValidationError):
        server.ChemicalLogIn(lines=[{"chemical": "TDI", "initial_quantity": 10, "used_quantity": 20}])
    for bad in ({"chemical": "TDI"}, {"chemical": " ", "remaining_estimate": 1},
                {"chemical": "TDI", "remaining_estimate": -1}):
        with pytest.raises(ValidationError):
            server.ChemicalLogIn(lines=[bad])
    with pytest.raises(ValidationError):
        server.ChemicalLogIn(lines=[])


def test_chemical_access_rules():
    server.require_chemical_access(MANUFACTURING)
    server.require_chemical_access({**MANUFACTURING, "is_worker": True, "worker_allowed_sections": ["warehouses"]})
    server.require_chemical_access({
        **MANUFACTURING, "is_worker": True, "worker_allowed_sections": ["warehouse-chemical"],
    })
    server.require_chemical_access({
        "_active_company_id": server.DEFAULT_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["chemical-usage-log"],
    })
    with pytest.raises(HTTPException):
        server.require_chemical_access({"_active_company_id": "iqfoam-whole-sallers"})
    server.require_chemical_access({"_active_company_id": server.DEFAULT_COMPANY_ID})
    with pytest.raises(HTTPException):
        server.require_chemical_access({**MANUFACTURING, "is_worker": True, "worker_allowed_sections": ["stock"]})
