import asyncio

import pytest
from fastapi import HTTPException

import server


class Coll:
    def __init__(self):
        self.docs = []

    async def find_one(self, q, p=None):
        return next((d for d in self.docs if all(d.get(k) == v for k, v in q.items())), None)

    async def delete_one(self, q):
        self.docs = [d for d in self.docs if d.get("id") != q.get("id")]


@pytest.fixture
def env(monkeypatch):
    colls = {"stock": Coll(), "prices": Coll()}

    class DB:
        stock = colls["stock"]
        prices = colls["prices"]

    async def insert(name, data):
        rec = {**data, "id": f"{name}-{len(colls[name].docs)}"}
        colls[name].docs.append(rec)
        return dict(rec)

    async def listall(name, *a, **k):
        return list(colls[name].docs)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(server, "db", DB)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "ensure_product_identification", noop)
    monkeypatch.setattr(server, "log_audit", noop)
    monkeypatch.setattr(server, "uses_unified_price_list", lambda c: True)
    return colls


def test_add_stock_saves_product_and_price(env):
    body = server.StockIn(product=" PINK RIBBON ", size="910/100", opening=3, selling_price=250)
    asyncio.run(server.add_stock(body, {"is_worker": False}))
    assert env["stock"].docs[0]["product"] == "PINK RIBBON"
    price = env["prices"].docs[0]
    assert (price["category"], price["size"], price["price"], price["zone"]) == ("PINK RIBBON", "910/100", 250, 1)
    assert price["confirmed"] and price["active"]


def test_non_owner_stock_creation_keeps_selling_price_but_not_purchase_cost(env):
    body = server.StockIn(
        product="Foam", size="100x100", opening=1, unit_cost=40, selling_price=250,
    )
    asyncio.run(server.add_stock(body, {"_active_role": "admin"}))

    stock = env["stock"].docs[0]
    assert "unit_cost" not in stock
    price = env["prices"].docs[0]
    assert price["price"] == 250


def test_add_stock_assigns_size_to_selected_category(env):
    body = server.StockIn(
        product="Manually entered product",
        category="Ribbon Black",
        size="910/100",
        opening=3,
        selling_price=250,
    )
    asyncio.run(server.add_stock(body, {"is_worker": False}))

    stock = env["stock"].docs[0]
    price = env["prices"].docs[0]
    assert (stock["product"], stock["size"]) == ("Ribbon Black", "910/100")
    assert (price["category"], price["size"], price["price"]) == ("Ribbon Black", "910/100", 250)


def test_add_stock_rejects_duplicates(env):
    body = server.StockIn(product="Simple", size="910x100", selling_price=10)
    asyncio.run(server.add_stock(body, {"is_worker": False}))
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.add_stock(body.model_copy(update={"product": "simple"}), {"is_worker": False}))
    assert err.value.status_code == 400
    assert len(env["stock"].docs) == 1
