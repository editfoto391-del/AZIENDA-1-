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


def test_monthly_chemical_sheet_accepts_daily_production_for_selected_month():
    day = {
        "date": "2026-11-16",
        "big_block": {"quantity": 1, "weight_kg": 500},
    }

    sheet = server.MonthlyChemicalSheetIn(**valid_monthly_sheet(production_days=[day]))

    assert sheet.production_days[0].date == "2026-11-16"
    assert sheet.production_days[0].big_block.quantity == 1
    assert sheet.production_days[0].small_block.quantity is None


def test_production_view_uses_monthly_managed_block_counts_for_same_date():
    rows = server.merge_monthly_sheet_production(
        [
            {"id": "legacy-production", "date": "2026-11-16", "blocks": [{"block": "White", "quantity": 99}]},
            {"id": "older-production", "date": "2026-11-15", "blocks": [{"block": "Black", "quantity": 2}]},
        ],
        [{
            "month": "2026-11",
            "production_days": [{
                "date": "2026-11-16",
                "big_block": {"quantity": 6},
                "medium_block": {"quantity": 3},
            }],
        }],
    )

    assert rows[0]["date"] == "2026-11-16"
    assert rows[0]["source"] == "monthly_chemical_sheet"
    assert rows[0]["total_blocks"] == 9
    assert rows[0]["blocks"] == [
        {"block": "BIG BLOCK 2750", "quantity": 6},
        {"block": "MEDIUM BLOCK", "quantity": 3},
    ]
    assert rows[1]["id"] == "older-production"


def test_production_view_syncs_legacy_weekly_management_counts_without_inventing_a_day():
    rows = server.merge_monthly_sheet_production(
        [
            {"id": "legacy-production-a", "date": "2026-11-03", "blocks": [{"block": "White", "quantity": 2}]},
            {"id": "legacy-production-b", "date": "2026-11-06", "blocks": [{"block": "Blue", "quantity": 1}]},
        ],
        [{
            "month": "2026-11",
            "weeks": [
                {},
                {
                    "big_block": {"quantity": 6, "weight_kg": 3000},
                    "medium_block": {"quantity": 3, "weight_kg": 1200},
                },
            ],
        }],
    )

    assert rows == [{
        "id": "monthly-sheet-production:2026-11:week:1",
        "date": "2026-11-08",
        "period_start": "2026-11-02",
        "period_end": "2026-11-08",
        "week_number": 2,
        "blocks": [
            {"block": "BIG BLOCK 2750", "quantity": 6},
            {"block": "MEDIUM BLOCK", "quantity": 3},
        ],
        "total_blocks": 9,
        "notes": "",
        "source": "monthly_chemical_sheet_weekly",
    }]


def test_daily_management_entries_replace_legacy_weekly_totals_in_production():
    rows = server.merge_monthly_sheet_production(
        [{"id": "legacy-production", "date": "2026-11-03", "blocks": [{"block": "White", "quantity": 99}]}],
        [{
            "month": "2026-11",
            "weeks": [{}, {"big_block": {"quantity": 6, "weight_kg": 3000}}],
            "production_days": [{
                "date": "2026-11-03",
                "week_index": 1,
                "big_block": {"quantity": 2, "weight_kg": 1000},
            }],
        }],
    )

    assert len(rows) == 1
    assert rows[0]["source"] == "monthly_chemical_sheet"
    assert rows[0]["blocks"] == [{"block": "BIG BLOCK 2750", "quantity": 2}]


def test_daily_production_endpoint_returns_monthly_management_blocks(monkeypatch):
    async def listall(collection, filters=None, sort=None):
        if collection == "production_daily":
            return [{
                "id": "legacy-production",
                "date": "2026-11-16",
                "blocks": [{"block": "White", "quantity": 99}],
            }]
        if collection == "monthly_chemical_sheets":
            return [{
                "month": "2026-11",
                "production_days": [{
                    "date": "2026-11-16",
                    "big_block": {"quantity": 6},
                    "medium_block": {"quantity": 3},
                }],
            }]
        raise AssertionError(f"Unexpected collection: {collection}")

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "period_starts", lambda: ("2026-11-16", "2026-11-01"))

    result = asyncio.run(server.get_daily_prod(
        page=1,
        page_size=50,
        user={"_active_company_id": server.MANUFACTURING_COMPANY_ID},
    ))

    assert result["total"] == 1
    assert result["rows"][0]["total_blocks"] == 9
    assert result["week"]["total_blocks"] == 9
    assert result["month"]["total_blocks"] == 9


def test_daily_production_endpoint_includes_legacy_weekly_totals_in_period_summaries(monkeypatch):
    async def listall(collection, filters=None, sort=None):
        if collection == "production_daily":
            return []
        if collection == "monthly_chemical_sheets":
            return [{
                "month": "2026-11",
                "weeks": [{}, {}, {}, {"big_block": {"quantity": 6, "weight_kg": 3000}}],
            }]
        raise AssertionError(f"Unexpected collection: {collection}")

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "period_starts", lambda: ("2026-11-16", "2026-11-01"))
    monkeypatch.setattr(server, "today_str", lambda: "2026-11-20")

    result = asyncio.run(server.get_daily_prod(
        page=1,
        page_size=50,
        user={"_active_company_id": server.MANUFACTURING_COMPANY_ID},
    ))

    assert result["today"]["total_blocks"] == 0
    assert result["week"]["total_blocks"] == 6
    assert result["month"]["total_blocks"] == 6


def test_blank_monthly_sheet_day_does_not_hide_legacy_production():
    rows = server.merge_monthly_sheet_production(
        [{"id": "legacy-production", "date": "2026-11-16", "blocks": [{"block": "White", "quantity": 4}]}],
        [{"month": "2026-11", "production_days": [{"date": "2026-11-16", "big_block": {"quantity": None}}]}],
    )

    assert len(rows) == 1
    assert rows[0]["id"] == "legacy-production"
    assert rows[0]["total_blocks"] == 4


def test_block_cutting_accepts_an_explicit_cut_date():
    record = server.BlockCuttingIn(
        block="White",
        size="50mm",
        date="2026-11-12",
        pieces_recovered=5,
    )

    assert record.date == "2026-11-12"
    with pytest.raises(ValueError):
        server.BlockCuttingIn(
            block="White",
            size="50mm",
            date="2026-11-31",
            pieces_recovered=5,
        )


def test_monthly_chemical_sheet_rejects_duplicate_or_out_of_month_production_days():
    day = {"date": "2026-11-16"}
    with pytest.raises(ValueError, match="only be saved once"):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(production_days=[day, day]))

    with pytest.raises(ValueError, match="belong to the selected month"):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(
            production_days=[{"date": "2026-10-31"}],
        ))

    with pytest.raises(ValueError, match="valid ISO date"):
        server.MonthlySheetProductionDayIn(date="2026-11-31")


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
    assert result[0]["items"][0]["capacity_kg"] == 200
    assert result[0]["items"][0]["container_type"] == "Barrel"


def test_monthly_chemical_sheet_converts_liter_grv_capacity_to_kg(monkeypatch):
    class FakeGrvs:
        async def find_one(self, query, projection):
            return {
                "id": "grv-liters",
                "grv_number": "GRV-L",
                "received_date": "2026-11-12",
                "supplier_name": "Chemical Supplier",
                "status": "completed",
                "purpose": "raw_material",
                "is_chemical": True,
                "items": [{
                    "product": "PPG (Polyol)",
                    "size": "1000",
                    "container_type": "Barrel",
                    "unit": "L",
                    "accepted_quantity": 2,
                }],
            }

    monkeypatch.setattr(server, "db", SimpleNamespace(grvs=FakeGrvs()))
    source = server.MonthlySheetArrivalSourceIn(
        grv_id="grv-liters",
        lines=[{"line_index": 0, "chemical_key": "ppg"}],
    )

    result = asyncio.run(server.validate_monthly_sheet_arrival_sources("2026-11", [source]))

    assert result[0]["lines"][0] == {
        "line_index": 0,
        "chemical_key": "ppg",
        "product": "PPG (Polyol)",
        "container_type": "Barrel",
        "container_capacity": 1000,
        "container_count": 2,
        "unit": "kg",
        "quantity_kg": 2000,
    }


def test_confirmed_chemical_grv_exposes_liter_amount_as_kg(monkeypatch):
    class FakeCursor:
        def sort(self, fields):
            return self

        async def to_list(self, length):
            return [{
                "id": "grv-liters",
                "grv_number": "GRV-L",
                "received_date": "2026-11-12",
                "supplier_name": "Chemical Supplier",
                "status": "completed",
                "purpose": "raw_material",
                "is_chemical": True,
                "items": [{
                    "product": "PPG (Polyol)",
                    "size": "1000",
                    "container_type": "Barrel",
                    "unit": "L",
                    "accepted_quantity": 2,
                }],
            }]

    class FakeGrvs:
        def find(self, query, projection):
            return FakeCursor()

    monkeypatch.setattr(server, "db", SimpleNamespace(grvs=FakeGrvs()))
    user = {"_active_company_id": "superiqfoam"}

    result = asyncio.run(server.get_monthly_chemical_sheet_grvs("2026-11", user))

    assert result[0]["items"][0]["capacity"] == 1000
    assert result[0]["items"][0]["capacity_kg"] == 1000
    assert result[0]["items"][0]["unit"] == "L"
    assert result[0]["items"][0]["quantity_kg"] == 2000


def test_monthly_chemical_sheet_rejects_negative_values_and_unknown_fields():
    arrivals = {**valid_monthly_sheet()["arrivals"], "ppg": -1}
    with pytest.raises(ValueError):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(arrivals=arrivals))

    arrivals = {**valid_monthly_sheet()["arrivals"], "unlisted": 1}
    with pytest.raises(ValueError):
        server.MonthlyChemicalSheetIn(**valid_monthly_sheet(arrivals=arrivals))


def test_monthly_chemical_sheet_is_company_scoped_and_authorized_workers():
    server.require_monthly_chemical_sheet_access({"_active_company_id": "superiqfoam"})
    server.require_monthly_chemical_sheet_access({"_active_company_id": "iqfoam-manufactoring"})
    with pytest.raises(HTTPException) as wrong_company:
        server.require_monthly_chemical_sheet_access({"_active_company_id": "imraan-plastics"})
    assert wrong_company.value.status_code == 403

    with pytest.raises(HTTPException) as denied_worker:
        server.require_monthly_chemical_sheet_access({
            "_active_company_id": "iqfoam-manufactoring",
            "is_worker": True,
            "worker_allowed_sections": ["production"],
        })
    assert denied_worker.value.status_code == 403

    server.require_monthly_chemical_sheet_access({
        "_active_company_id": "superiqfoam",
        "is_worker": True,
        "worker_allowed_sections": ["superiqfoam-monthly-sheet"],
    })
    server.require_monthly_chemical_sheet_access({
        "_active_company_id": "superiqfoam",
        "is_worker": True,
        "worker_allowed_sections": ["chemical-usage-log"],
    })
    manufacturing_worker = {
        "_active_company_id": "iqfoam-manufactoring",
        "is_worker": True,
        "worker_allowed_sections": ["warehouse-a"],
    }
    server.require_monthly_chemical_sheet_access(manufacturing_worker)
    assert server.worker_section_for_request(
        "warehouses/production-chemical-balance", manufacturing_worker,
    ) == "warehouse-a"


def test_monthly_chemical_sheet_ids_are_separate_by_company():
    assert server.monthly_chemical_sheet_id("superiqfoam", "2026-11") == "monthly-chemical-sheet:2026-11"
    assert server.monthly_chemical_sheet_id(
        "iqfoam-manufactoring", "2026-11",
    ) == "monthly-chemical-sheet:iqfoam-manufactoring:2026-11"


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


def test_manufacturing_monthly_sheet_custom_link_uses_warehouse_a_access():
    section = {
        "id": "production-chemical-balance",
        "label": "Production Management & Chemical Balance",
        "path": "/warehouses/production-chemical-balance",
    }
    config = server.normalize_interface_config(
        {"custom_sections": [section]},
        company_id=server.MANUFACTURING_COMPANY_ID,
    )
    assert config["custom_sections"][0]["access_section"] == "warehouse-a"
    assert "warehouse-chemical" not in server.INTERFACE_NAV_GROUPS["warehouses"]
    assert "warehouse-chemical-inventory" not in server.INTERFACE_NAV_GROUPS["warehouses"]
    migrated = server.normalize_interface_config({
        "section_order": {
            "warehouses": [
                "warehouse-a", "warehouse-chemical", "warehouse-chemical-inventory",
                "warehouse-b", "warehouse-c",
            ],
        },
    }, company_id=server.MANUFACTURING_COMPANY_ID)
    assert migrated["section_order"]["warehouses"] == [
        "warehouse-a", "warehouse-b", "warehouse-c",
    ]
