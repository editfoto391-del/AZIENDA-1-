import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


class Orders:
    def __init__(self, rows):
        self.rows = {row["id"]: deepcopy(row) for row in rows}

    async def find_one(self, query, *_args, **_kwargs):
        row = self.rows.get(query["id"])
        return deepcopy(row) if row else None

    async def update_one(self, query, update):
        row = self.rows.get(query["id"])
        if not row:
            return SimpleNamespace(matched_count=0)
        if row.get("invoice_id") and row["invoice_id"] != query["$or"][1]["invoice_id"]:
            return SimpleNamespace(matched_count=0)
        row.update(deepcopy(update["$set"]))
        return SimpleNamespace(matched_count=1)


def test_validate_invoice_order_ids_accepts_unlinked_order_for_customer(monkeypatch):
    orders = Orders([{
        "id": "order-1",
        "customer_id": "customer-1",
        "customer_name": "Customer",
        "status": "To Send",
    }])
    monkeypatch.setattr(server, "db", SimpleNamespace(orders=orders))

    result = asyncio.run(server.validate_invoice_order_ids(
        [" order-1 "], "customer-1", "Customer",
    ))

    assert result == ["order-1"]


def test_validate_invoice_order_ids_rejects_order_already_invoiced(monkeypatch):
    orders = Orders([{
        "id": "order-1",
        "customer_id": "customer-1",
        "invoice_id": "invoice-1",
    }])
    monkeypatch.setattr(server, "db", SimpleNamespace(orders=orders))

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.validate_invoice_order_ids(
            ["order-1"], "customer-1", "Customer",
        ))

    assert error.value.status_code == 409


def test_link_invoice_orders_marks_order_as_invoiced(monkeypatch):
    orders = Orders([{"id": "order-1"}])
    monkeypatch.setattr(server, "db", SimpleNamespace(orders=orders))
    monkeypatch.setattr(server, "now_iso", lambda: "2026-11-09T10:00:00+00:00")

    asyncio.run(server.link_invoice_orders({
        "id": "invoice-1",
        "number": "INV-101",
        "order_ids": ["order-1"],
    }))

    assert orders.rows["order-1"]["invoice_id"] == "invoice-1"
    assert orders.rows["order-1"]["invoice_number"] == "INV-101"
    assert orders.rows["order-1"]["updated_at"] == "2026-11-09T10:00:00+00:00"
