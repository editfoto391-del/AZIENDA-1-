import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


def valid_monthly_sheet(**overrides):
    values = {
        "ppg": None,
        "tdi": None,
        "t9": None,
        "silicone": None,
        "amine52": None,
        "mcl": None,
    }
    blocks = {
        key: {"quantity": None, "weight_kg": None}
        for key in server.MONTHLY_SHEET_BLOCK_KEYS
    }
    payload = {
        "month": "2026-11",
        "arrivals": values,
        "minimums": values,
        "formula_rates": {key: values for key in server.MONTHLY_SHEET_BLOCK_KEYS},
        "weeks": [
            blocks
            for _ in server.calendar.Calendar(firstweekday=server.calendar.MONDAY)
            .monthdayscalendar(2026, 11)
        ],
    }
    payload.update(overrides)
    return payload


def test_monthly_chemical_sheet_accepts_calendar_week_rows():
    sheet = server.MonthlyChemicalSheetIn(**valid_monthly_sheet())

    assert sheet.month == "2026-11"
    assert len(sheet.weeks) == 6
    assert set(sheet.formula_rates) == server.MONTHLY_SHEET_BLOCK_KEYS


@pytest.mark.parametrize("month", ["2026-00", "2026-13", "26-11"])
def test_monthly_chemical_sheet_rejects_invalid_months(month):
    with pytest.raises(ValueError):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(month=month))


@pytest.mark.parametrize("week_count", [0, 4, 5, 7])
def test_monthly_chemical_sheet_requires_number_of_weeks_in_selected_month(week_count):
    with pytest.raises(ValueError, match="exactly 6 production weeks"):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(
            weeks=[valid_monthly_sheet()["weeks"][0] for _ in range(week_count)],
        ))


def test_monthly_chemical_sheet_rejects_duplicate_grvs_and_duplicate_line_mappings():
    source = {"grv_id": "grv-1", "lines": [{"line_index": 0, "chemical_key": "ppg"}]}
    with pytest.raises(ValueError, match="monthly sheet once"):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(
            arrival_sources=[source, source],
        ))

    with pytest.raises(ValueError, match="only be mapped once"):
        server.MonthlySheetArrivalSourceIn(
            grv_id="grv-1",
            lines=[
                {"line_index": 0, "chemical_key": "ppg"},
                {"line_index": 0, "chemical_key": "tdi"},
            ],
        )


def test_monthly_chemical_sheet_grv_source_is_verified_and_converted_to_kg(monkeypatch):
    class FakeGrvs:
        async def find_one(self, query, projection):
            assert query == {"id": "grv-1"}
            return {
                "id": "grv-1",
                "grv_number": "GRV-001",
                "received_date": "2026-11-12",
                "supplier_name": "Chemical Supplier",
                "status": "completed",
                "purpose": "raw_material",
                "is_chemical": True,
                "items": [
                    {
                        "product": "PPG",
                        "size": "200",
                        "container_type": "Barrel",
                        "unit": "kg",
                        "accepted_quantity": 3,
                    },
                ],
            }

    monkeypatch.setattr(server, "db", SimpleNamespace(grvs=FakeGrvs()))
    source = server.MonthlySheetArrivalSourceIn(
        grv_id="grv-1",
        lines=[{"line_index": 0, "chemical_key": "ppg"}],
    )

    result = asyncio.run(server.validate_monthly_sheet_arrival_sources("2026-11", [source]))

    assert result == [{
        "grv_id": "grv-1",
        "grv_number": "GRV-001",
        "received_date": "2026-11-12",
        "supplier_name": "Chemical Supplier",
        "lines": [{
            "line_index": 0,
            "chemical_key": "ppg",
            "product": "PPG",
            "container_type": "Barrel",
            "container_capacity": 200,
            "container_count": 3,
            "unit": "kg",
            "quantity_kg": 600,
        }],
    }]


def test_monthly_chemical_sheet_rejects_ineligible_grv_sources(monkeypatch):
    class FakeGrvs:
        async def find_one(self, query, projection):
            return {
                "id": "grv-1",
                "received_date": "2026-11-12",
                "status": "draft",
                "purpose": "raw_material",
                "is_chemical": True,
                "items": [],
            }

    monkeypatch.setattr(server, "db", SimpleNamespace(grvs=FakeGrvs()))
    source = server.MonthlySheetArrivalSourceIn(
        grv_id="grv-1",
        lines=[{"line_index": 0, "chemical_key": "ppg"}],
    )

    with pytest.raises(HTTPException) as invalid:
        asyncio.run(server.validate_monthly_sheet_arrival_sources("2026-11", [source]))
    assert invalid.value.status_code == 422


def test_confirmed_superiqfoam_chemical_grv_is_available_to_monthly_sheet(monkeypatch):
    class FakeCursor:
        def sort(self, fields):
            return self

        async def to_list(self, length):
            assert length is None
            return [{
                "id": "grv-1",
                "grv_number": "GRV-001",
                "received_date": "2026-11-12",
                "supplier_name": "Chemical Supplier",
                "status": "completed",
                "purpose": "raw_material",
                "is_chemical": True,
                "items": [{
                    "product": "PPG",
                    "size": "200",
                    "container_type": "Barrel",
                    "unit": "kg",
                    "accepted_quantity": 3,
                }],
            }]

    class FakeGrvs:
        def find(self, query, projection):
            assert query == {
                "received_date": {"$gte": "2026-11-01", "$lte": "2026-11-30"},
                "status": {"$in": ["completed", "partially_received", "discrepancy"]},
                "purpose": "raw_material",
                "is_chemical": True,
            }
            return FakeCursor()

    monkeypatch.setattr(server, "db", SimpleNamespace(grvs=FakeGrvs()))
    user = {"_active_company_id": "superiqfoam"}

    result = asyncio.run(server.get_monthly_chemical_sheet_grvs("2026-11", user))

    assert result[0]["id"] == "grv-1"
    assert result[0]["items"][0]["quantity_kg"] == 600
    assert result[0]["items"][0]["accepted_quantity"] == 3
    assert result[0]["items"][0]["capacity"] == 200
    assert result[0]["items"][0]["container_type"] == "Barrel"


def test_monthly_chemical_sheet_rejects_negative_values_and_unknown_fields():
    arrivals = {**valid_monthly_sheet()["arrivals"], "ppg": -1}
    with pytest.raises(ValueError):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(arrivals=arrivals))

    arrivals = {**valid_monthly_sheet()["arrivals"], "unlisted": 1}
    with pytest.raises(ValueError):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(arrivals=arrivals))


def test_monthly_chemical_sheet_is_limited_to_superiqfoam_and_authorized_workers():
    server.require_superiqfoam_monthly_sheet_access({"_active_company_id": "superiqfoam"})
    with pytest.raises(HTTPException) as wrong_company:
        server.require_superiqfoam_monthly_sheet_access({"_active_company_id": "iqfoam-manufactoring"})
    assert wrong_company.value.status_code == 403

    with pytest.raises(HTTPException) as denied_worker:
        server.require_superiqfoam_monthly_sheet_access({
            "_active_company_id": "superiqfoam",
            "is_worker": True,
            "worker_allowed_sections": ["production"],
        })
    assert denied_worker.value.status_code == 403

    server.require_superiqfoam_monthly_sheet_access({
        "_active_company_id": "superiqfoam",
        "is_worker": True,
        "worker_allowed_sections": ["superiqfoam-monthly-sheet"],
    })
    server.require_superiqfoam_monthly_sheet_access({
        "_active_company_id": "superiqfoam",
        "is_worker": True,
        "worker_allowed_sections": ["chemical-usage-log"],
    })


def test_monthly_sheet_is_a_distinct_superiqfoam_navigation_section():
    config = server.normalize_interface_config({})

    assert "superiqfoam-monthly-sheet" in config["section_order"]["production"]
    assert "chemicals-quantity" not in config["section_order"]["production"]
    assert "chemical-usage-log" not in config["section_order"]["production"]
    assert "chemicals-quantity" in server.INTERFACE_SECTIONS
    assert "chemical-usage-log" in server.INTERFACE_SECTIONS


def test_legacy_chemical_navigation_order_migrates_to_monthly_sheet():
    config = server.normalize_interface_config({
        "section_order": {
            "production": [
                "production", "chemicals-quantity", "chemical-usage-log",
            ],
        },
    })

    assert config["section_order"]["production"] == [
        "production", "superiqfoam-monthly-sheet",
    ]


def test_monthly_sheet_custom_link_is_only_available_to_superiqfoam():
    section = {
        "id": "monthly-sheet",
        "label": "Monthly sheet",
        "path": "/production/monthly-sheet",
    }
    config = server.normalize_interface_config(
        {"custom_sections": [section]},
        company_id=server.DEFAULT_COMPANY_ID,
    )
    assert config["custom_sections"][0]["access_section"] == "superiqfoam-monthly-sheet"

    with pytest.raises(HTTPException) as invalid:
        server.normalize_interface_config(
            {"custom_sections": [section]},
            company_id=server.MANUFACTURING_COMPANY_ID,
        )
    assert invalid.value.status_code == 422
