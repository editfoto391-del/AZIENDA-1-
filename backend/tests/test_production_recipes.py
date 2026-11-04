import asyncio

import pytest
from fastapi import HTTPException
from pymongo.errors import OperationFailure

import server
from production_recipes import PREDEFINED_BLOCK_RECIPES


def test_med_recipe_keeps_tdi_quantity_unconverted_until_unit_confirmation():
    recipe = next(recipe for recipe in PREDEFINED_BLOCK_RECIPES if recipe["id"] == "med-2350")
    tdi = next(component for component in recipe["components"] if component["chemical"] == "TDI")
    mcl = next(component for component in recipe["components"] if component["chemical"] == "MCL")

    assert tdi["quantity"] == 28
    assert tdi["unit"] == ""
    assert tdi["unit_confirmation_required"] is True
    assert mcl["quantity"] == 6.2
    assert mcl["unit"] == ""
    assert mcl["unit_confirmation_required"] is True


@pytest.mark.parametrize(
    ("recipe_id", "quantity"),
    [("big-block-2750", 1), ("big-block-2750", 3)],
)
def test_big_block_production_allocates_exact_recipe_quantities(monkeypatch, recipe_id, quantity):
    recipe = next(item for item in PREDEFINED_BLOCK_RECIPES if item["id"] == recipe_id)
    inventory = [{
        "id": f"inventory-{index}",
        "chemical": component["chemical"],
        "unit": component["unit"],
        "capacity": component["quantity"] * quantity,
        "count": 1,
        "quantity_used": 0,
    } for index, component in enumerate(recipe["components"])]

    async def fake_listall(collection, *args, **kwargs):
        assert collection == "chemical_inventory"
        return inventory

    monkeypatch.setattr(server, "listall", fake_listall)
    _, allocations, _ = asyncio.run(server._production_material_allocations(
        recipe["components"], quantity,
    ))

    assert [allocation["quantity"] for allocation in allocations] == [
        component["quantity"] * quantity for component in recipe["components"]
    ]


def test_recipe_costs_match_spec_and_small_block_ppg_totals_27_3_kg():
    big, med, small = PREDEFINED_BLOCK_RECIPES
    assert round(sum(item["cost"] or 0 for item in big["components"]), 2) == 3430.25
    assert round(sum(item["cost"] or 0 for item in med["components"]), 2) == 2979.91
    assert round(sum(item["cost"] or 0 for item in small["components"]), 2) == 2747.44
    assert next(item for item in small["components"] if item.get("label") == "PPG additional")["quantity"] == 300
    ppg = [item for item in small["components"] if item["chemical"] == "PPG"]
    total_ppg_kg = sum(
        server._convert_production_quantity(item["quantity"], item["unit"], "kg")
        for item in ppg
    )
    assert total_ppg_kg == pytest.approx(27.3)
    assert next(item for item in small["components"] if item["chemical"] == "H2O")["cost"] is None


def test_small_block_ppg_allocation_combines_27_kg_and_300_grams(monkeypatch):
    ppg_inventory = [{
        "id": "ppg",
        "chemical": "PPG",
        "unit": "kg",
        "capacity": 30,
        "count": 1,
        "quantity_used": 0,
    }]
    recipe = next(item for item in PREDEFINED_BLOCK_RECIPES if item["id"] == "small-2150")
    ppg_components = [item for item in recipe["components"] if item["chemical"] == "PPG"]

    async def fake_listall(collection, *args, **kwargs):
        return ppg_inventory

    monkeypatch.setattr(server, "listall", fake_listall)
    _, allocations, _ = asyncio.run(server._production_material_allocations(ppg_components, 1))

    assert sum(item["quantity"] for item in allocations) == pytest.approx(27.3)


def test_custom_formula_allocates_multiple_existing_chemicals(monkeypatch):
    inventory = [
        {"id": "ppg", "chemical": "PPG", "unit": "kg", "capacity": 10, "count": 1, "quantity_used": 0},
        {"id": "tdi", "chemical": "TDI", "unit": "kg", "capacity": 2, "count": 1, "quantity_used": 0},
    ]

    async def fake_listall(collection, *args, **kwargs):
        return inventory

    monkeypatch.setattr(server, "listall", fake_listall)
    _, allocations, initial = asyncio.run(server._production_material_allocations(
        [
            {"chemical": "PPG", "unit": "kg", "quantity": 1.5},
            {"chemical": "TDI", "unit": "g", "quantity": 500},
        ],
        2,
    ))

    assert [amount for amount in initial] == [10, 2000]
    assert [(item["chemical"], item["quantity"], item["unit"]) for item in allocations] == [
        ("PPG", 3, "kg"),
        ("TDI", 1, "kg"),
    ]


def test_production_quantity_conversion_only_converts_matching_unit_families():
    assert server._convert_production_quantity(1, "kg", "g") == 1000
    assert server._convert_production_quantity(1, "L", "ml") == 1000

    with pytest.raises(HTTPException) as error:
        server._convert_production_quantity(1, "kg", "L")

    assert error.value.status_code == 409


def test_material_allocation_accounts_for_prior_usage_and_converts_units(monkeypatch):
    async def fake_listall(collection, *args, **kwargs):
        assert collection == "chemical_inventory"
        return [{
            "id": "tdi-1",
            "chemical": "TDI",
            "unit": "kg",
            "capacity": 10,
            "count": 1,
            "quantity_used": 2,
        }]

    monkeypatch.setattr(server, "listall", fake_listall)
    rows, allocations, initial = asyncio.run(server._production_material_allocations(
        [{"chemical": "tdi", "unit": "g", "quantity": 100}], 2,
    ))

    assert rows[0]["id"] == "tdi-1"
    assert initial == [8000]
    assert allocations == [{
        "component_index": 0,
        "inventory_id": "tdi-1",
        "chemical": "tdi",
        "quantity": 0.2,
        "unit": "kg",
    }]


def test_material_allocation_rejects_insufficient_chemical_stock(monkeypatch):
    async def fake_listall(collection, *args, **kwargs):
        return [{
            "id": "tdi-1",
            "chemical": "TDI",
            "unit": "kg",
            "capacity": 1,
            "count": 1,
            "quantity_used": 0.5,
        }]

    monkeypatch.setattr(server, "listall", fake_listall)
    with pytest.raises(HTTPException) as error:
        asyncio.run(server._production_material_allocations(
            [{"chemical": "TDI", "unit": "kg", "quantity": 0.3}], 2,
        ))

    assert error.value.status_code == 409
    assert "Insufficient chemical stock" in error.value.detail


def test_transaction_unavailable_is_detected_for_standalone_mongodb():
    error = OperationFailure(
        "Transaction numbers are only allowed on a replica set member or mongos",
        code=20,
    )

    assert server._transaction_unavailable(error)


def test_completed_production_request_is_idempotent(monkeypatch):
    completed = {"id": "production-1", "request_id": "request-123456", "status": "completed"}

    class Records:
        calls = 0

        async def find_one(self, query, projection):
            self.calls += 1
            assert query == {"request_id": "request-123456"}
            return completed

    records = Records()
    monkeypatch.setattr(server, "db", type("Database", (), {"production_block_records": records})())
    async def no_recipe_seed():
        raise AssertionError("completed retries must return before recipe or stock work")

    monkeypatch.setattr(server, "ensure_predefined_block_recipes", no_recipe_seed)
    result = asyncio.run(server.record_block_production(
        server.BlockProductionIn(
            request_id="request-123456",
            block_type="BIG BLOCK 2750",
            quantity=1,
            components=[{"chemical": "PPG", "quantity": 1, "unit": "kg"}],
        ),
        {"_active_company_id": "iqfoam-manufactoring", "id": "supervisor"},
    ))

    assert result is completed
    assert records.calls == 1


def test_block_production_is_restricted_to_manufacturing():
    with pytest.raises(HTTPException) as error:
        server._require_block_production_access({"_active_company_id": "superiqfoam"})

    assert error.value.status_code == 403


def test_manual_recipe_creation_preserves_unconfirmed_units(monkeypatch):
    class Recipes:
        documents = []

        async def insert_one(self, recipe):
            self.documents.append(recipe)

    recipes = Recipes()
    monkeypatch.setattr(server, "db", type("Database", (), {"production_block_recipes": recipes})())
    monkeypatch.setattr(server, "new_id", lambda: "custom-recipe-1")

    async def no_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "log_audit", no_audit)
    result = asyncio.run(server.create_production_block_recipe(
        server.ProductionRecipeIn(
            block_type="Custom 2200",
            components=[{
                "chemical": "TDI",
                "quantity": 28,
                "unit": "",
                "unit_confirmation_required": True,
            }],
        ),
        {
            "_active_company_id": "iqfoam-manufactoring",
            "_active_role": "admin",
            "id": "admin-1",
        },
    ))

    assert result["id"] == "custom-recipe-1"
    assert result["version"] == 1
    assert result["components"][0]["quantity"] == 28
    assert result["components"][0]["unit"] == ""
    assert result["components"][0]["unit_confirmation_required"] is True


def test_chemical_inventory_setting_ids_are_company_scoped():
    manufacturing_id = server.chemical_inventory_setting_id("iqfoam-manufactoring", "PPG", "kg")
    default_id = server.chemical_inventory_setting_id("superiqfoam", "PPG", "kg")

    assert manufacturing_id != default_id
    assert server.chemical_inventory_setting_id("iqfoam-manufactoring", "ppg", "KG") == manufacturing_id
