import asyncio
from copy import deepcopy

import pytest
from fastapi import HTTPException

import server


class FakeCollection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        return deepcopy(next((doc for doc in self.documents if all(doc.get(k) == v for k, v in query.items())), None))

    def find(self, query, projection=None):
        return FakeCursor(self.documents)


class FakeCursor:
    def __init__(self, documents):
        self.documents = deepcopy(documents)

    async def to_list(self, limit):
        return self.documents if limit is None else self.documents[:limit]


class FakeDatabase:
    def __init__(self):
        self.stock = FakeCollection([{
            "id": "stock-1", "product": "Simple", "size": "1070x100", "current": 0,
        }])
        self.stock_movements = FakeCollection()

    def __getitem__(self, collection):
        return getattr(self, collection)


def test_invoice_negative_stock_requires_confirmation_and_is_scoped(monkeypatch):
    fake_db = FakeDatabase()
    monkeypatch.setattr(server, "db", fake_db)
    monkeypatch.setattr(server, "stock_current", lambda stock: _async_noop(stock))
    inserted_movements = []

    async def insert(collection, data):
        movement = {**deepcopy(data), "id": f"movement-{len(inserted_movements) + 1}"}
        inserted_movements.append(movement)
        return movement

    async def no_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "log_audit", no_audit)
    stock = fake_db.stock.documents[0]
    deduction = [{
        "stock_id": "stock-1", "product": "Simple", "size": "1070x100",
        "quantity": server.D("1"),
    }]
    user = {"email": "owner@example.test"}

    async def scenario():
        with pytest.raises(HTTPException) as error:
            await server.validate_invoice_stock(deepcopy(deduction))
        assert error.value.status_code == 409
        assert error.value.detail == {
            "code": "INSUFFICIENT_STOCK",
            "items": [{
                "product": "Simple", "size": "1070x100", "available": 0.0,
                "requested": 1.0, "stock_after": -1.0,
            }],
        }

        confirmed_deductions = deepcopy(deduction)
        await server.validate_invoice_stock(confirmed_deductions, allow_negative_stock=True)
        await server.post_invoice_stock_deductions(
            {"id": "invoice-1", "number": "INV-1"}, confirmed_deductions, user,
        )
        assert inserted_movements[0]["direction"] == -1
        assert inserted_movements[0]["quantity"] == 1
        assert inserted_movements[0]["batch_allocations"][0]["cost_status"] == "unavailable"
        assert inserted_movements[0]["batch_allocations"][0]["unit_cost"] is None

        changes = {"stock-1": server.D("1")}
        with pytest.raises(HTTPException) as edit_error:
            await server.validate_invoice_stock_changes(changes)
        assert edit_error.value.status_code == 409
        edit_stocks = await server.validate_invoice_stock_changes(changes, allow_negative_stock=True)
        await server.post_invoice_stock_changes(
            {"id": "invoice-2", "number": "INV-2"}, changes, edit_stocks, user,
        )
        assert inserted_movements[1]["direction"] == -1

        with pytest.raises(HTTPException) as generic_movement:
            await server.post_movement(stock, "invoice", 1, user)
        assert generic_movement.value.status_code == 400

    asyncio.run(scenario())


async def _async_noop(*args, **kwargs):
    return None
