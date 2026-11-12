import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server


class SupplierCollection:
    def __init__(self, documents):
        self.documents = deepcopy(documents)

    async def find_one(self, query, projection=None):
        return deepcopy(next(
            (document for document in self.documents if document.get("id") == query["id"]),
            None,
        ))

    async def update_one(self, query, update):
        document = next(
            (item for item in self.documents if item.get("id") == query["id"]),
            None,
        )
        if not document:
            return SimpleNamespace(matched_count=0)
        for key, amount in update.get("$inc", {}).items():
            document[key] = (document.get(key) or 0) + amount
        for key, value in update.get("$push", {}).items():
            document.setdefault(key, []).append(deepcopy(value))
        document.update(update.get("$set", {}))
        return SimpleNamespace(matched_count=1)


def test_supplier_balance_defaults_to_zero_and_accepts_currency_amounts():
    assert server.SupplierIn(name="Supplier").balance == 0
    assert server.SupplierIn(name="Supplier", balance=1234.56).model_dump()["balance"] == 1234.56


def test_supplier_balance_rejects_non_finite_amounts():
    with pytest.raises(ValidationError):
        server.SupplierIn(name="Supplier", balance=float("inf"))


def test_supplier_balance_adjustments_update_balance_and_keep_history(monkeypatch):
    collection = SupplierCollection([{"id": "supplier-1", "name": "Foam Supply", "balance": 100}])
    audit_entries = []
    monkeypatch.setattr(server, "db", SimpleNamespace(suppliers=collection))

    async def log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "log_audit", log_audit)
    user = {"id": "user-1", "name": "Supplier Manager"}

    async def adjust():
        added = await server.adjust_supplier_balance(
            "supplier-1",
            server.SupplierBalanceIn(
                direction="add", amount=25.50, date="2026-11-12", notes="Invoice correction",
            ),
            user,
        )
        reduced = await server.adjust_supplier_balance(
            "supplier-1",
            server.SupplierBalanceIn(
                direction="subtract", amount=10, date="2026-11-13", notes="Payment",
            ),
            user,
        )
        return added, reduced

    added, reduced = asyncio.run(adjust())

    assert added["balance"] == 125.5
    assert reduced["balance"] == 115.5
    assert [entry["direction"] for entry in reduced["balance_history"]] == ["add", "subtract"]
    assert reduced["balance_history"][0]["notes"] == "Invoice correction"
    assert reduced["balance_history"][1]["created_by_name"] == "Supplier Manager"
    assert [entry[0][2] for entry in audit_entries] == ["balance_add", "balance_subtract"]


def test_supplier_balance_adjustment_rejects_missing_supplier(monkeypatch):
    monkeypatch.setattr(server, "db", SimpleNamespace(suppliers=SupplierCollection([])))
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.adjust_supplier_balance(
            "missing",
            server.SupplierBalanceIn(direction="add", amount=10),
            {"id": "user-1"},
        ))
    assert error.value.status_code == 404


@pytest.mark.parametrize(
    "values",
    [
        {"direction": "add", "amount": 0},
        {"direction": "subtract", "amount": -1},
        {"direction": "other", "amount": 1},
        {"direction": "add", "amount": 1, "date": "2026-02-30"},
    ],
)
def test_supplier_balance_adjustment_rejects_invalid_input(values):
    with pytest.raises(ValidationError):
        server.SupplierBalanceIn(**values)
