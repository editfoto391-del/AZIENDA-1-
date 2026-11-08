import asyncio
from types import SimpleNamespace

import pytest

import server


class MockCollection:
    def __init__(self, record=None):
        self.record = record

    async def find_one(self, query, *_args, **_kwargs):
        if self.record and (
            query.get("source_buying_id") == self.record.get("source_buying_id")
            or query.get("id") == self.record.get("id")
        ):
            return dict(self.record)
        return None


def install_grv_transfer_mocks(monkeypatch, *, grv=None, stock=None, inventory=None):
    database = SimpleNamespace(
        grvs=MockCollection(grv),
        suppliers=MockCollection(),
        stock=MockCollection(stock),
    )
    monkeypatch.setattr(server, "db", database)
    stock_items = stock if isinstance(stock, list) else ([stock] if stock else [])
    monkeypatch.setattr(server, "listall", lambda collection, *_args, **_kwargs: asyncio.sleep(
        0, result={
            "stock": stock_items,
            "company_inventory": inventory or [],
            "chemical_inventory": [],
        }.get(collection, []),
    ))
    inserted = []
    updated = []
    confirmed = []

    async def insert_record(collection, data):
        record = {"id": "grv-created", **data}
        inserted.append((collection, record))
        return record

    async def update_record(collection, record_id, data):
        updated.append((collection, record_id, data))
        return {"id": record_id, **data}

    async def log_audit(*_args, **_kwargs):
        return None

    async def emit_event(*_args, **_kwargs):
        return None

    async def next_reference(*_args, **_kwargs):
        return "GRV-2026-0001"

    async def confirm_grv(grv_id, _user):
        confirmed.append(grv_id)
        return {"id": grv_id, "status": "completed"}

    monkeypatch.setattr(server, "insert", insert_record)
    monkeypatch.setattr(server, "update_doc", update_record)
    monkeypatch.setattr(server, "log_audit", log_audit)
    monkeypatch.setattr(server, "emit_workflow_event", emit_event)
    monkeypatch.setattr(server, "next_ref", next_reference)
    monkeypatch.setattr(server, "confirm_grv", confirm_grv)
    async def normalize_selling_items(items, *_args, **_kwargs):
        return items

    monkeypatch.setattr(server, "_grv_items_from_request", normalize_selling_items)
    monkeypatch.setattr(
        server, "_raw_grv_items",
        lambda items, _chemical, **_kwargs: items,
    )
    return inserted, updated, confirmed


def test_selling_buying_creates_selling_grv_without_sale_price(monkeypatch):
    stock = {"id": "stock-1", "product": "Foam", "size": "910x100", "code": "F-1"}
    inserted, updated, confirmed = install_grv_transfer_mocks(monkeypatch, stock=stock)

    result = asyncio.run(server._create_grv_from_buying({
        "id": "buying-1",
        "source": "Supplier",
        "product": "Foam",
        "size": "910x100",
        "stock_id": "stock-1",
        "item_type": "selling_product",
        "quantity": 3,
        "unit_price": 120,
        "date": "2026-11-02",
    }, {"email": "owner@example.com", "name": "Owner"}))

    grv = inserted[0][1]
    assert result[1] is True
    assert result[0]["status"] == "completed"
    assert confirmed == ["grv-created"]
    assert grv["purpose"] == "selling"
    assert grv["source_buying_id"] == "buying-1"
    assert grv["received_date"] == "2026-11-02"
    assert grv["items"][0]["stock_id"] == "stock-1"
    assert grv["items"][0]["unit_cost"] == 120
    assert "sale_price_zone_1" not in grv["items"][0]
    assert updated[0][2]["transferred_to_grv_id"] == "grv-created"


def test_selling_buying_without_size_keeps_size_blank_and_creates_stock_grv(monkeypatch):
    inserted, _, confirmed = install_grv_transfer_mocks(monkeypatch)

    asyncio.run(server._create_grv_from_buying({
        "id": "buying-no-size",
        "product": "Custom foam",
        "item_type": "selling_product",
        "quantity": 3,
        "unit_price": 120,
    }, {"email": "owner@example.com", "name": "Owner"}))

    line = inserted[0][1]["items"][0]
    assert line["size"] == ""
    assert line["new_product"] is True
    assert confirmed == ["grv-created"]


def test_selling_buying_without_stock_id_uses_existing_stock_product(monkeypatch):
    stock = {"id": "stock-existing", "product": "Foam", "size": "910x100", "code": "F-1"}
    inserted, _, confirmed = install_grv_transfer_mocks(monkeypatch, stock=stock)

    asyncio.run(server._create_grv_from_buying({
        "id": "buying-existing-stock",
        "product": "foam",
        "size": "910X100",
        "item_type": "selling_product",
        "quantity": 3,
        "unit_price": 120,
    }, {"email": "owner@example.com", "name": "Owner"}))

    line = inserted[0][1]["items"][0]
    assert line["stock_id"] == "stock-existing"
    assert line["new_product"] is False
    assert line["product"] == "Foam"
    assert line["size"] == "910x100"
    assert confirmed == ["grv-created"]


def test_selling_buying_with_stale_stock_id_uses_existing_product_match(monkeypatch):
    stock = {"id": "stock-existing", "product": "Foam", "size": "910x100", "code": "F-1"}
    inserted, _, confirmed = install_grv_transfer_mocks(monkeypatch, stock=stock)

    asyncio.run(server._create_grv_from_buying({
        "id": "buying-stale-stock-match",
        "product": "Foam",
        "size": "910x100",
        "stock_id": "stock-deleted",
        "item_type": "selling_product",
        "quantity": 3,
        "unit_price": 120,
    }, {"email": "owner@example.com", "name": "Owner"}))

    line = inserted[0][1]["items"][0]
    assert line["stock_id"] == "stock-existing"
    assert line["new_product"] is False
    assert confirmed == ["grv-created"]


def test_selling_buying_with_stale_stock_id_falls_back_to_new_product(monkeypatch):
    inserted, _, confirmed = install_grv_transfer_mocks(monkeypatch)

    asyncio.run(server._create_grv_from_buying({
        "id": "buying-stale-stock",
        "product": "Custom foam",
        "size": "910x100",
        "stock_id": "stock-deleted",
        "item_type": "selling_product",
        "quantity": 3,
        "unit_price": 120,
    }, {"email": "owner@example.com", "name": "Owner"}))

    line = inserted[0][1]["items"][0]
    assert line["stock_id"] == ""
    assert line["new_product"] is True
    assert line["product"] == "Custom foam"
    assert line["size"] == "910x100"
    assert confirmed == ["grv-created"]


def test_selling_grv_accepts_blank_size_for_buying_origin(monkeypatch):
    install_grv_transfer_mocks(monkeypatch)

    items = asyncio.run(server._grv_items_from_request([{
        "product": "Custom foam",
        "size": "",
        "new_product": True,
        "actual_received_quantity": 3,
        "accepted_quantity": 3,
        "unit_cost": 120,
    }], allow_blank_new_product_size=True))

    assert items[0]["size"] == ""
    assert items[0]["new_product"] is True
    assert items[0]["accepted_quantity"] == 3


def test_raw_buying_uses_matching_company_inventory_unit_and_category(monkeypatch):
    inventory = [{
        "id": "inventory-1",
        "name": "Fabric roll",
        "size": "large",
        "unit": "rolls",
        "category": "Fabric Roll",
    }]
    inserted, _, confirmed = install_grv_transfer_mocks(monkeypatch, inventory=inventory)

    asyncio.run(server._create_grv_from_buying({
        "id": "buying-2",
        "source": "Fabric supplier",
        "product": "Fabric roll",
        "size": "large",
        "item_type": "raw_material",
        "quantity": 2,
        "unit_price": 50,
        "date": "2026-11-03",
    }, {"email": "owner@example.com", "name": "Owner"}))

    grv = inserted[0][1]
    assert grv["purpose"] == "raw_material"
    assert grv["is_chemical"] is False
    assert grv["items"][0]["unit"] == "rolls"
    assert grv["items"][0]["category"] == "Fabric Roll"
    assert grv["items"][0]["accepted_quantity"] == 2
    assert confirmed == ["grv-created"]


def test_raw_buying_without_known_measure_unit_is_not_misclassified(monkeypatch):
    install_grv_transfer_mocks(monkeypatch)

    line, is_chemical, unit = asyncio.run(server._buying_grv_line({
        "product": "Unknown material",
        "size": "",
        "item_type": "raw_material",
        "quantity": 5,
        "unit_price": 10,
    }))

    assert line["unit"] == ""
    assert line["size"] == ""
    assert unit == ""
    assert is_chemical is False


def test_raw_grv_from_buying_allows_missing_unit_and_size():
    line = server._raw_grv_items([{
        "product": "Unspecified material",
        "size": "",
        "unit": "",
        "actual_received_quantity": 5,
        "accepted_quantity": 5,
        "unit_cost": 10,
    }], False, allow_missing_unit=True, allow_missing_chemical_size=True)[0]

    assert line["size"] == ""
    assert line["unit"] == ""
    assert line["accepted_quantity"] == 5


@pytest.mark.parametrize(
    ("daily_quantity", "quantity_field", "expected_quantity"),
    [(None, "loose_units", 7), (4, "daily_remaining_quantity", 9)],
)
def test_raw_grv_updates_company_inventory_once_with_blank_unit(
    monkeypatch, daily_quantity, quantity_field, expected_quantity,
):
    inventory = {
        "id": "inventory-blank-unit",
        "name": "Unspecified material",
        "category": "Other",
        "size": "",
        "unit": "",
        "loose_units": 2,
        "daily_remaining_quantity": daily_quantity,
    }

    class InventoryCollection:
        async def find_one(self, query, *_args, **_kwargs):
            if query.get("id") == inventory["id"]:
                return dict(inventory)
            name_pattern = query.get("name", {}).get("$regex")
            size_pattern = query.get("size", {}).get("$regex")
            unit_pattern = query.get("unit", {}).get("$regex")
            if (
                name_pattern == "^Unspecified\\ material$"
                and size_pattern == "^$"
                and unit_pattern == "^$"
            ):
                return dict(inventory)
            return None

    class MovementCollection:
        def __init__(self):
            self.records = []

        async def find_one(self, query, *_args, **_kwargs):
            return next(
                (dict(record) for record in self.records
                 if record.get("dedupe_key") == query.get("dedupe_key")),
                None,
            )

    movements = MovementCollection()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        company_inventory=InventoryCollection(),
        raw_material_movements=movements,
    ))

    async def insert_record(collection, data):
        record = {"id": f"{collection}-{len(movements.records) + 1}", **data}
        if collection == "raw_material_movements":
            movements.records.append(record)
        return record

    async def update_record(collection, record_id, data):
        assert collection == "company_inventory"
        assert record_id == inventory["id"]
        inventory.update(data)
        return dict(inventory)

    monkeypatch.setattr(server, "insert", insert_record)
    monkeypatch.setattr(server, "update_doc", update_record)
    grv = {
        "id": "grv-blank-unit",
        "grv_number": "GRV-2026-0099",
        "items": [{
            "product": "Unspecified material",
            "category": "Other",
            "size": "",
            "unit": "",
            "container_type": "Barrel",
            "accepted_quantity": 5,
        }],
    }

    first = asyncio.run(server._apply_raw_grv(grv, {"email": "owner@example.com"}, 1))
    retry = asyncio.run(server._apply_raw_grv(grv, {"email": "owner@example.com"}, 1))

    assert inventory[quantity_field] == expected_quantity
    assert first[0]["collection"] == "company_inventory"
    assert retry == []
    assert len(movements.records) == 1


def test_buying_with_non_numeric_values_returns_a_validation_error():
    with pytest.raises(server.HTTPException, match="must be numeric"):
        asyncio.run(server._buying_grv_line({
            "product": "Foam",
            "size": "910x100",
            "item_type": "selling_product",
            "quantity": "unknown",
            "unit_price": 10,
        }))


def test_ambiguous_raw_inventory_match_requires_correction(monkeypatch):
    inventory = [
        {"id": "inventory-1", "name": "Fabric roll", "size": "large", "unit": "rolls"},
        {"id": "inventory-2", "name": "Fabric roll", "size": "large", "unit": "rolls"},
    ]
    install_grv_transfer_mocks(monkeypatch, inventory=inventory)

    line, _, _ = asyncio.run(server._buying_grv_line({
        "product": "Fabric roll",
        "size": "large",
        "quantity_unit": "rolls",
        "item_type": "raw_material",
        "quantity": 2,
        "unit_price": 50,
    }))

    assert line["unit"] == "rolls"
    assert line["size"] == "large"


def test_existing_grv_is_reused_and_buying_is_linked(monkeypatch):
    existing = {
        "id": "grv-existing",
        "source_buying_id": "buying-3",
        "grv_number": "GRV-2026-0002",
        "status": "draft",
    }
    inserted, updated, confirmed = install_grv_transfer_mocks(monkeypatch, grv=existing)

    result = asyncio.run(server._create_grv_from_buying(
        {"id": "buying-3"}, {"email": "owner@example.com"},
    ))

    assert result == ({"id": "grv-existing", "status": "completed"}, False)
    assert inserted == []
    assert confirmed == ["grv-existing"]
    assert confirmed == ["grv-existing"]
    assert updated[0][2]["transferred_to_grv_id"] == "grv-existing"


def test_batch_transfer_requires_global_owner(monkeypatch):
    called = []

    def require_owner(user):
        called.append(user)
        raise server.HTTPException(403, "Global Owner access required")

    monkeypatch.setattr(server, "require_global_owner", require_owner)

    with pytest.raises(server.HTTPException) as error:
        asyncio.run(server.transfer_buyings_to_grv(
            server.BuyingGRVTransferIn(buying_ids=["buying-1"]),
            user={"role": "admin"},
        ))

    assert error.value.status_code == 403
    assert called == [{"role": "admin"}]


def test_sale_price_remains_optional_only_for_buying_origin_grvs():
    line = {"new_product": True, "accepted_quantity": 1, "product": "Foam", "size": "910x100"}

    assert server._grv_sale_price_updates([line], {"_active_company_id": "superiqfoam"},
                                          require_new_product_prices=False) == []
    with pytest.raises(server.HTTPException, match="sale price"):
        server._grv_sale_price_updates([line], {"_active_company_id": "superiqfoam"})
