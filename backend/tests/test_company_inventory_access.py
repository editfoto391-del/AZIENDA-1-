import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


def test_company_inventory_worker_access_is_read_only_for_stock_workers():
    worker = {"is_worker": True, "worker_allowed_sections": ["stock"]}

    server.require_company_inventory_access(worker, read_only=True)

    with pytest.raises(HTTPException) as error:
        server.require_company_inventory_access(worker)
    assert error.value.status_code == 403

    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/company-inventory"),
        method="GET",
    )
    server.enforce_worker_api_access(request, worker)

    request.method = "POST"
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request, worker)
    assert error.value.status_code == 403


def test_company_inventory_is_not_visible_to_workers_without_stock_access():
    worker = {"is_worker": True, "worker_allowed_sections": ["invoices"]}

    with pytest.raises(HTTPException) as error:
        server.require_company_inventory_access(worker, read_only=True)
    assert error.value.status_code == 403


def test_company_inventory_is_available_to_company_users():
    server.require_company_inventory_access({"is_worker": False})


def test_company_inventory_total_uses_latest_daily_quantity():
    item = {
        "packages": 3,
        "units_per_package": 10,
        "loose_units": 2,
        "daily_remaining_quantity": 14,
    }

    assert server.company_inventory_total(item) == 14


def test_company_inventory_daily_update_saves_quantity_and_daily_history(monkeypatch):
    item = {
        "id": "inventory-1",
        "name": "Glue",
        "unit": "kg",
        "packages": 10,
        "units_per_package": 10,
        "loose_units": 0,
        "stock_reference_quantity": 100,
    }
    daily_updates = []

    class CompanyInventory:
        async def find_one(self, query, projection=None):
            return dict(item) if query.get("id") == item["id"] else None

        async def update_one(self, query, update):
            item.update(update["$set"])
            return SimpleNamespace(matched_count=1)

    class DailyUpdates:
        async def update_one(self, query, update, upsert=False):
            daily_updates.append((query, update, upsert))

    class DB:
        company_inventory = CompanyInventory()
        company_inventory_daily_updates = DailyUpdates()

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "update_low_stock_notification", noop)
    monkeypatch.setattr(server, "log_audit", noop)
    monkeypatch.setattr(server, "now_iso", lambda: "2026-11-03T12:00:00+00:00")
    monkeypatch.setattr(server, "new_id", lambda: "daily-update-1")

    result = asyncio.run(
        server.update_company_inventory_daily_quantity(
            "inventory-1",
            server.CompanyInventoryDailyUpdateIn(date="2026-11-03", quantity=42),
            user={"id": "admin", "_active_company_id": "company-a"},
        )
    )

    assert result["total"] == 42
    assert result["daily_remaining_date"] == "2026-11-03"
    assert item["stock_reference_quantity"] == 100
    assert daily_updates[0][0] == {
        "company_inventory_id": "inventory-1",
        "date": "2026-11-03",
    }
    assert daily_updates[0][1]["$set"]["quantity"] == 42
    assert daily_updates[0][2] is True
