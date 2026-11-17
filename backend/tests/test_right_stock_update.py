import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server


class NoopStockLock:
    def __init__(self, _ids):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


def owner():
    return {
        "role": "owner",
        "email": "owner@example.com",
        "company_id": server.DEFAULT_COMPANY_ID,
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }


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


def test_daily_count_catalog_includes_all_sizes_and_extra_stock():
    specs = server.daily_stock_count_specs([
        {"id": "a", "product": "Ribbon Balck", "size": "760/100", "opening": 10},
        {"id": "b", "product": "Ribbon Black", "size": "760x100", "opening": 3},
        {"id": "c", "product": "Custom Item", "size": "Large", "opening": 1},
    ])
    keyed_specs = {server.daily_stock_identity_key(row["product"], row["size"]): row for row in specs}

    ribbon = keyed_specs[server.daily_stock_identity_key("Ribbon Black", "760x100")]
    assert ribbon["product"] == "Ribbon Black"
    assert {stock["id"] for stock in ribbon["records"]} == {"a", "b"}
    assert server.daily_stock_identity_key("White Drum", "1000L") in keyed_specs
    assert server.daily_stock_identity_key("Custom Item", "Large") in keyed_specs


def test_daily_count_input_rejects_duplicate_category_and_size():
    with pytest.raises(ValidationError, match="only be counted once"):
        server.DailyStockReconciliationIn(
            report_date=server.today_str(),
            counts=[
                {"product": "Ribbon Balck", "size": "760/100", "quantity": 3},
                {"product": "Ribbon Black", "size": "760x100", "quantity": 3},
            ],
        )


def test_daily_count_sheet_shows_ledger_balance_and_today_movements(monkeypatch):
    today = server.today_str()
    stock = {
        "id": "stock-1",
        "product": "Simple",
        "size": "760x50",
        "opening": 10,
    }
    all_movements = [
        {
            "stock_id": "stock-1",
            "type": "invoice",
            "quantity": 2,
            "direction": -1,
            "date": today,
            "created_at": f"{today}T10:00:00+00:00",
        },
        {
            "stock_id": "stock-1",
            "type": "purchase",
            "quantity": 4,
            "direction": 1,
            "date": "2020-01-01",
            "created_at": "2020-01-01T10:00:00+00:00",
        },
        {
            "stock_id": "stock-1",
            "type": "purchase",
            "quantity": 1,
            "direction": 1,
            "date": today,
            "created_at": f"{today}T11:00:00+00:00",
        },
    ]

    async def listall(collection, filters=None, *_args, **_kwargs):
        if collection == "stock":
            return [stock]
        assert collection == "stock_movements"
        return [movement for movement in all_movements if movement["date"] == filters["date"]]

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(
        server,
        "stock_movements_for_stock_ids",
        lambda ids: asyncio.sleep(0, result={"stock-1": all_movements}),
    )
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(stock_daily_reconciliations=SimpleNamespace(
            find_one=lambda *_args, **_kwargs: asyncio.sleep(0, result=None),
        )),
    )

    report = asyncio.run(server.daily_stock_reconciliation_data(today))
    row = next(item for item in report["rows"] if item["product"] == "Simple" and item["size"] == "760x50")

    assert row["book_quantity"] == 13
    assert row["invoice_out"] == 2
    assert row["received_in"] == 1
    assert report["activity"]["invoice_out"] == 2
    assert report["activity"]["received_in"] == 1


def test_daily_count_requires_a_complete_catalog(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    rows = [
        {
            "key": server.daily_stock_identity_key(spec["product"], spec["size"]),
            "product": spec["product"],
            "size": spec["size"],
        }
        for spec in server.daily_stock_count_specs([])
    ]
    monkeypatch.setattr(
        server,
        "daily_stock_reconciliation_data",
        lambda _date: asyncio.sleep(0, result={"rows": rows}),
    )
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.update_daily_stock_reconciliation(
            server.DailyStockReconciliationIn(
                report_date=server.today_str(),
                counts=[{"product": rows[0]["product"], "size": rows[0]["size"], "quantity": 0}],
            ),
            owner(),
        ))

    assert error.value.status_code == 422
    assert error.value.detail["missing_count"] == len(rows) - 1


def test_daily_count_records_audited_adjustments_and_preserves_history(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    stocks = [{
        "id": "stock-1",
        "product": "Simple",
        "size": "760x50",
        "opening": 5,
    }]
    specs = server.daily_stock_count_specs(stocks)
    counts = [
        {
            "product": spec["product"],
            "size": spec["size"],
            "made_today": 3 if spec["product"] == "Simple" and spec["size"] == "760x50" else 0,
            "quantity": 8 if spec["product"] == "Simple" and spec["size"] == "760x50" else None,
        }
        for spec in specs
    ]
    reconciliation_rows = [
        {
            "key": server.daily_stock_identity_key(spec["product"], spec["size"]),
            "product": spec["product"],
            "size": spec["size"],
            "book_quantity": 5 if spec["product"] == "Simple" and spec["size"] == "760x50" else 0,
        }
        for spec in specs
    ]
    monkeypatch.setattr(
        server,
        "daily_stock_reconciliation_data",
        lambda _date: asyncio.sleep(0, result={"rows": reconciliation_rows}),
    )
    monkeypatch.setattr(server, "listall", lambda collection, *_args, **_kwargs: asyncio.sleep(
        0, result=stocks if collection == "stock" else [],
    ))
    monkeypatch.setattr(
        server,
        "stock_movements_for_stock_ids",
        lambda stock_ids: asyncio.sleep(0, result={stock_id: [] for stock_id in stock_ids}),
    )
    movements = []
    audits = []

    async def post_movement(stock, movement_type, quantity, _user, **kwargs):
        movement = {
            "id": f"movement-{len(movements)}",
            "stock_id": stock["id"],
            "type": movement_type,
            "quantity": quantity,
            "created_at": server.now_iso(),
            **kwargs,
        }
        movements.append(movement)
        return movement

    async def log_audit(*args, **kwargs):
        audits.append((args, kwargs))

    async def save_record(collection, data):
        assert collection == "stock_daily_reconciliations"
        return {"id": data["id"], **data}

    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "log_audit", log_audit)
    monkeypatch.setattr(server, "insert", save_record)
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(stock_daily_reconciliations=SimpleNamespace(
            find_one=lambda *_args, **_kwargs: asyncio.sleep(0, result=None),
        )),
    )

    result = asyncio.run(server.update_daily_stock_reconciliation(
        server.DailyStockReconciliationIn(report_date=server.today_str(), counts=counts),
        owner(),
    ))

    assert result["rows"] == reconciliation_rows
    assert len(movements) == 1
    assert movements[0]["type"] == "production"
    assert movements[0]["quantity"] == 3
    assert movements[0]["direction"] == 1
    assert movements[0]["reference"] == server.today_str()
    assert len(audits) == 2
    assert any(args[0] == "stock_daily_reconciliation" for args, _ in audits)


def test_daily_production_update_is_idempotent_when_compiled_again(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    monkeypatch.setattr(server, "StockLock", NoopStockLock)
    stocks = [{
        "id": "stock-1",
        "product": "Simple",
        "size": "760x50",
        "opening": 0,
    }]
    specs = server.daily_stock_count_specs(stocks)
    rows = [
        {
            "key": server.daily_stock_identity_key(spec["product"], spec["size"]),
            "product": spec["product"],
            "size": spec["size"],
        }
        for spec in specs
    ]
    stored = {}
    movements = []

    async def listall(collection, *_args, **_kwargs):
        return stocks if collection == "stock" else []

    async def movements_for_stock(stock_ids):
        grouped = {stock_id: [] for stock_id in stock_ids}
        grouped["stock-1"] = list(movements)
        return grouped

    async def post_movement(stock, movement_type, quantity, _user, **kwargs):
        movement = {
            "id": f"movement-{len(movements)}",
            "stock_id": stock["id"],
            "type": movement_type,
            "quantity": quantity,
            "created_at": server.now_iso(),
            **kwargs,
        }
        movements.append(movement)
        return movement

    async def insert(collection, data):
        assert collection == "stock_daily_reconciliations"
        stored.update({"id": data["id"], **data})
        return dict(stored)

    async def update_doc(collection, _record_id, data):
        assert collection == "stock_daily_reconciliations"
        stored.update(data)
        return dict(stored)

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "stock_movements_for_stock_ids", movements_for_stock)
    monkeypatch.setattr(server, "post_movement", post_movement)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    monkeypatch.setattr(
        server,
        "daily_stock_reconciliation_data",
        lambda _date: asyncio.sleep(0, result={"rows": rows}),
    )
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(stock_daily_reconciliations=SimpleNamespace(
            find_one=lambda *_args, **_kwargs: asyncio.sleep(0, result=dict(stored) if stored else None),
        )),
    )

    def submit(made_today):
        counts = [
            {
                "product": spec["product"],
                "size": spec["size"],
                "made_today": made_today if spec["product"] == "Simple" and spec["size"] == "760x50" else 0,
            }
            for spec in specs
        ]
        return asyncio.run(server.update_daily_stock_reconciliation(
            server.DailyStockReconciliationIn(report_date=server.today_str(), counts=counts),
            owner(),
        ))

    submit(3)
    submit(5)
    submit(5)

    assert [(movement["quantity"], movement["direction"]) for movement in movements] == [
        (3, 1),
        (2, 1),
    ]
    saved_line = next(line for line in stored["counts"] if line["product"] == "Simple" and line["size"] == "760x50")
    assert saved_line["made_today"] == 5


def test_daily_reconciliation_rejects_non_global_owner_before_reading_stock(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "owner@example.com")
    read_attempted = False

    async def listall(*_args, **_kwargs):
        nonlocal read_attempted
        read_attempted = True
        return []

    monkeypatch.setattr(server, "listall", listall)
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_daily_stock_reconciliation({
            **owner(),
            "role": "admin",
            "email": "admin@example.com",
        }))

    assert error.value.status_code == 403
    assert read_attempted is False
