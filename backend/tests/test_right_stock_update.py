import asyncio

import pytest
from fastapi import HTTPException

import server


class NoopStockLock:
    def __init__(self, _ids):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


def test_right_stock_targets_match_the_supplied_line_items():
    totals = {}
    for product, _size, quantity in server.RIGHT_STOCK_UPDATE_ITEMS:
        if product != "White Drum":
            totals[product] = totals.get(product, 0) + quantity

    assert len(server.RIGHT_STOCK_UPDATE_ITEMS) == 63
    assert totals == {
        "Simple": 4749,
        "Ribbon Black": 240,
        "Ribbon Pink": 222,
        "Candy": 25,
        "Strong Boy": 15,
        "Uncovered": 0,
    }
    assert sum(totals.values()) == 5251


def test_update_right_stock_records_adjustments_and_preserves_history(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    stocks = [
        {
            "id": f"stock-{index}",
            "product": product,
            "size": size,
            "opening": quantity + (10 if index == 0 else 0),
        }
        for index, (product, size, quantity) in enumerate(server.RIGHT_STOCK_UPDATE_ITEMS[:-1])
    ]
    movements = []
    audits = []

    async def listall(collection, *_args, **_kwargs):
        assert collection == "stock"
        return stocks

    async def insert(collection, data, **_kwargs):
        assert collection == "stock"
        record = {"id": "new-stock", **data}
        stocks.append(record)
        return record

    async def movements_for_stock(stock_ids):
        return {stock_id: [] for stock_id in stock_ids}

    async def post_movement(stock, movement_type, quantity, _user, **kwargs):
        direction = 1 if movement_type == "adjustment_in" else -1
        stock["opening"] += direction * quantity
        movement = {
            "id": f"movement-{len(movements)}",
            "stock_id": stock["id"],
            "type": movement_type,
            "quantity": quantity,
            "direction": direction,
            **kwargs,
        }
        movements.append(movement)
        return movement

    async def log_audit(*args, **kwargs):
        audits.append((args, kwargs))

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "stock_movements_for_stock_ids", movements_for_stock)
    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "log_audit", log_audit)

    result = asyncio.run(server.update_right_stock({
        "role": "owner",
        "email": "owner@example.com",
        "company_id": server.DEFAULT_COMPANY_ID,
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }))

    assert result["updated_items"] == 63
    assert result["created_items"] == 1
    assert result["adjusted_items"] == 2
    assert result["net_mattress_stock"] == 5251
    assert [movement["type"] for movement in movements] == [
        "adjustment_out",
        "adjustment_out",
    ]
    assert movements[1]["quantity"] == 12
    assert movements[1]["allow_negative"] is True
    assert len(audits) == 2
    assert stocks[0]["opening"] == server.RIGHT_STOCK_UPDATE_ITEMS[0][2]
    assert stocks[-1]["opening"] == -12

    second_result = asyncio.run(server.update_right_stock({
        "role": "owner",
        "email": "owner@example.com",
        "company_id": server.DEFAULT_COMPANY_ID,
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }))

    assert second_result["adjusted_items"] == 0
    assert len(movements) == 2


def test_update_right_stock_rejects_non_global_owner_before_reading_stock(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    read_attempted = False

    async def listall(*_args, **_kwargs):
        nonlocal read_attempted
        read_attempted = True
        return []

    monkeypatch.setattr(server, "listall", listall)
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.update_right_stock({
            "role": "admin",
            "email": "admin@example.com",
            "company_id": server.DEFAULT_COMPANY_ID,
            "_active_company_id": server.DEFAULT_COMPANY_ID,
        }))

    assert error.value.status_code == 403
    assert read_attempted is False


def test_update_right_stock_zeroes_duplicates_without_deleting_stock(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    stocks = [{
        "id": f"stock-{index}",
        "product": product,
        "size": size,
        "opening": quantity,
    } for index, (product, size, quantity) in enumerate(server.RIGHT_STOCK_UPDATE_ITEMS)
        if (product, size) != ("Ribbon Black", "760x100") and product != "White Drum"]
    stocks.extend([
        {"id": "stock-duplicate-1", "product": "Ribbon Black", "size": "760x100", "opening": 10, "created_at": "2026-01-01"},
        {"id": "stock-duplicate-2", "product": "Ribbon Balck", "size": "760x100", "opening": 7, "created_at": "2026-02-01"},
    ])
    movements = []
    audits = []

    async def listall(collection, *_args, **_kwargs):
        assert collection == "stock"
        return stocks

    async def movements_for_stock(stock_ids):
        return {stock_id: [] for stock_id in stock_ids}

    async def insert(collection, data):
        assert collection == "stock"
        record = {"id": "new-stock", **data}
        stocks.append(record)
        return record

    async def post_movement(stock, movement_type, quantity, _user, **kwargs):
        direction = 1 if movement_type == "adjustment_in" else -1
        stock["opening"] += direction * quantity
        movement = {
            "id": f"movement-{len(movements)}",
            "stock_id": stock["id"],
            "type": movement_type,
            "quantity": quantity,
            "direction": direction,
            **kwargs,
        }
        movements.append(movement)
        return movement

    async def log_audit(*args, **kwargs):
        audits.append((args, kwargs))

    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "stock_movements_for_stock_ids", movements_for_stock)
    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "log_audit", log_audit)

    result = asyncio.run(server.update_right_stock({
        "role": "owner",
        "email": "owner@example.com",
        "company_id": server.DEFAULT_COMPANY_ID,
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }))

    assert result["duplicate_records_zeroed"] == 1
    assert len(stocks) == 64
    assert next(item for item in stocks if item["id"] == "stock-duplicate-1")["opening"] == 0
    assert next(item for item in stocks if item["id"] == "stock-duplicate-2")["opening"] == 25
    assert len(movements) == 3
    assert len(audits) == 3

    second_result = asyncio.run(server.update_right_stock({
        "role": "owner",
        "email": "owner@example.com",
        "company_id": server.DEFAULT_COMPANY_ID,
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }))

    assert second_result["adjusted_items"] == 0
    assert second_result["duplicate_records_zeroed"] == 1
    assert len(stocks) == 64
    assert len(movements) == 3
