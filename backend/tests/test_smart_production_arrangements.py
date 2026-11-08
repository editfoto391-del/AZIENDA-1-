import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest

import server


def test_smart_planner_rejects_other_company_profiles():
    with pytest.raises(server.HTTPException) as error:
        server.require_smart_production_planner({
            "_active_company_id": "iqfoam-manufactoring",
            "_active_role": "owner",
        })
    assert error.value.status_code == 403


def test_smart_planner_requires_company_administrator():
    with pytest.raises(server.HTTPException) as error:
        server.require_smart_production_planner({
            "_active_company_id": "superiqfoam",
            "_active_role": "user",
        })
    assert error.value.status_code == 403


def install_arrangement_mocks(monkeypatch, *, active_plans=None, orders=None):
    orders = orders if orders is not None else [{
        "id": "order-a",
        "reference": "ORD-A",
        "customer_name": "A Customer",
        "status": "To Send",
        "items": [{"qty": 5, "category": "Candy", "size": "1070x100"}],
    }]
    stock_items = [{
        "id": "stock-candy",
        "product": "Candy",
        "size": "1070x100",
        "opening": 2,
    }]
    active_plans = active_plans if active_plans is not None else []
    saved = {"plans": active_plans, "inserts": [], "updates": [], "audits": [], "released_locks": []}

    class PlannerLocks:
        async def delete_one(self, query):
            saved["released_locks"].append(query)

        async def find_one(self, _query, _projection=None):
            return None

    class PlannerPlans:
        async def find_one(self, _query, _projection=None):
            return None

    monkeypatch.setattr(server, "acquire_smart_production_planner_lock", lambda: asyncio.sleep(0, result="lock-owner"))
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(
            smart_production_arrangement_locks=PlannerLocks(),
            smart_production_arrangements=PlannerPlans(),
        ),
    )

    async def listall(collection, *_args, **_kwargs):
        if collection == "smart_production_arrangements":
            return list(saved["plans"])
        if collection == "orders":
            return deepcopy(orders)
        if collection == "stock":
            return deepcopy(stock_items)
        if collection == "employees":
            return []
        raise AssertionError(f"Unexpected collection read: {collection}")

    async def movements(_stock_ids):
        return {}

    async def insert(collection, data):
        assert collection == "smart_production_arrangements"
        result = {**data, "id": f"plan-{len(saved['inserts']) + 1}", "created_at": "2026-11-08T00:00:00Z"}
        saved["inserts"].append(result)
        saved["plans"].append(result)
        return result

    async def update_doc(collection, record_id, data):
        assert collection == "smart_production_arrangements"
        saved["updates"].append((record_id, data))
        existing = next(plan for plan in saved["plans"] if plan["id"] == record_id)
        updated = {**existing, **data, "id": record_id}
        saved["plans"] = [updated if plan["id"] == record_id else plan for plan in saved["plans"]]
        return updated

    async def audit(*args, **kwargs):
        saved["audits"].append((args, kwargs))

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "stock_movements_for_stock_ids", movements)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", audit)
    return saved


def test_duplicate_arrangement_reuses_and_revalidates_existing_proposal(monkeypatch):
    saved = install_arrangement_mocks(monkeypatch)
    user = {"id": "admin"}

    first = asyncio.run(server.create_or_refresh_smart_production_arrangement(["order-a"], user))
    second = asyncio.run(server.create_or_refresh_smart_production_arrangement(["order-a"], user))

    assert first["id"] == second["id"] == "plan-1"
    assert len(saved["inserts"]) == 1
    assert len(saved["updates"]) == 1
    assert second["total_available"] == 2
    assert second["total_missing"] == 3
    assert len(saved["released_locks"]) == 2


def test_selected_orders_merge_overlapping_active_arrangements(monkeypatch):
    saved = install_arrangement_mocks(
        monkeypatch,
        active_plans=[
            {"id": "plan-a", "status": "active", "order_ids": ["order-a"], "stock_reservations": []},
            {"id": "plan-b", "status": "active", "order_ids": ["order-b"], "stock_reservations": []},
        ],
        orders=[
            {
                "id": order_id,
                "reference": order_id.upper(),
                "customer_name": "Customer " + order_id,
                "status": "To Send",
                "items": [{"qty": 2, "category": "Candy", "size": "1070x100"}],
            }
            for order_id in ("order-a", "order-b")
        ],
    )

    plan = asyncio.run(server.create_or_refresh_smart_production_arrangement(
        ["order-a", "order-b"],
        {"id": "admin"},
    ))

    assert plan["order_ids"] == ["order-a", "order-b"]
    assert plan["id"] == "plan-a"
    assert len(saved["inserts"]) == 0
    assert len(saved["updates"]) == 2
    assert saved["plans"][0]["status"] == "active"
    assert saved["plans"][1]["status"] == "released"
    assert saved["plans"][1]["superseded_by"] == "plan-a"
    assert saved["audits"][-1][0][2] == "proposal_superseded"
    assert len(saved["released_locks"]) == 1


def test_releasing_arrangement_releases_planning_only_stock_allocations(monkeypatch):
    existing = {
        "id": "plan-1",
        "status": "active",
        "order_ids": ["order-a"],
        "stock_reservations": [{"product": "Simple", "size": "1070x100", "quantity": 2}],
    }
    saved = install_arrangement_mocks(monkeypatch, active_plans=[existing])
    user = {"id": "admin", "_active_company_id": "superiqfoam", "_active_role": "owner"}

    async def acquire():
        return "lock-owner"

    async def find_one(_query, _projection=None):
        return existing

    monkeypatch.setattr(server, "acquire_smart_production_planner_lock", acquire)
    monkeypatch.setattr(server.db.smart_production_arrangements, "find_one", find_one)

    released = asyncio.run(server.release_smart_production_arrangement("plan-1", user))

    assert released["status"] == "released"
    assert len(saved["updates"]) == 1
    assert saved["released_locks"][-1]["owner"] == "lock-owner"
    assert saved["audits"][-1][0][2] == "proposal_released"
