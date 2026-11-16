import asyncio

import pytest

import server
from tenancy import (
    DEFAULT_COMPANY_ID,
    ScopedCollection,
    active_company_id,
    tenant_database,
    uses_unified_price_list,
)
import seed_data


class FakeCollection:
    def __getattr__(self, name):
        def call(*args, **kwargs):
            return name, args, kwargs
        return call


class FakeDatabase:
    name = "iqfoam"

    def __getitem__(self, name):
        return FakeCollection()


class FakeClient:
    def __init__(self):
        self.requested_databases = []

    def __getitem__(self, name):
        self.requested_databases.append(name)
        database = FakeDatabase()
        database.name = name
        return database


def test_reads_are_scoped_to_the_active_company():
    token = active_company_id.set("iqfoam-manufactoring")
    try:
        collection = ScopedCollection(FakeCollection(), company_scoped=True)
        _, args, _ = collection.find_one({"id": "customer-1"})
        assert args[0] == {"$and": [{"id": "customer-1"}, {"company_id": "iqfoam-manufactoring"}]}
    finally:
        active_company_id.reset(token)


def test_missing_active_company_fails_closed_to_the_default_profile():
    collection = ScopedCollection(FakeCollection(), company_scoped=True)
    _, args, _ = collection.find_one({"id": "customer-1"})

    assert args[0] == {
        "$and": [{"id": "customer-1"}, {"company_id": DEFAULT_COMPANY_ID}]
    }


def test_insert_and_upsert_are_stamped_with_active_company():
    token = active_company_id.set("iqfoam-whole-sallers")
    try:
        collection = ScopedCollection(FakeCollection(), company_scoped=True)
        _, insert_args, _ = collection.insert_one({"id": "invoice-1"})
        assert insert_args[0]["company_id"] == "iqfoam-whole-sallers"

        _, update_args, _ = collection.update_one({"id": "invoice-2"}, {"$set": {"total": 10}}, upsert=True)
        assert update_args[0]["$and"][-1] == {"company_id": "iqfoam-whole-sallers"}
        assert update_args[1]["$set"]["company_id"] == "iqfoam-whole-sallers"
        assert "company_id" not in update_args[1].get("$setOnInsert", {})
    finally:
        active_company_id.reset(token)


def test_cross_company_filter_cannot_match_another_tenant():
    token = active_company_id.set("iqfoam-manufactoring")
    try:
        collection = ScopedCollection(FakeCollection(), company_scoped=True)
        _, args, _ = collection.find_one({"company_id": "iqfoam-whole-sallers"})
        assert args[0]["$and"] == [
            {"company_id": "iqfoam-whole-sallers"},
            {"company_id": "iqfoam-manufactoring"},
            {"company_id": {"$ne": "iqfoam-whole-sallers"}},
        ]
    finally:
        active_company_id.reset(token)

def test_aggregations_are_scoped_to_the_active_company():
    token = active_company_id.set("iqfoam-whole-sallers")
    try:
        collection = ScopedCollection(FakeCollection(), company_scoped=True)
        _, args, _ = collection.aggregate([{"$group": {"_id": None}}])
        assert args[0][0] == {"$match": {"company_id": "iqfoam-whole-sallers"}}
    finally:
        active_company_id.reset(token)


def test_cross_company_write_is_rejected():
    token = active_company_id.set("iqfoam-manufactoring")
    try:
        collection = ScopedCollection(FakeCollection(), company_scoped=True)
        with pytest.raises(ValueError, match="another company"):
            collection.insert_one({"id": "invoice-1", "company_id": "iqfoam-whole-sallers"})
    finally:
        active_company_id.reset(token)


def test_all_company_profiles_use_the_shared_database():
    client = FakeClient()
    base = FakeDatabase()
    assert tenant_database(client, base, None).name == base.name
    assert tenant_database(client, base, DEFAULT_COMPANY_ID).name == base.name
    assert tenant_database(client, base, "iqfoam-manufactoring").name == base.name
    assert client.requested_databases == []


def test_tenant_database_pins_company_scope_on_the_shared_database():
    base = FakeDatabase()
    database = tenant_database(FakeClient(), base, "iqfoam-manufactoring")
    token = active_company_id.set(DEFAULT_COMPANY_ID)
    try:
        _, args, _ = database.customers.find_one({"id": "customer-1"})
    finally:
        active_company_id.reset(token)

    assert args[0] == {
        "$and": [{"id": "customer-1"}, {"company_id": "iqfoam-manufactoring"}]
    }


def test_company_unique_index_replaces_legacy_global_index():
    class IndexCollection:
        def __init__(self):
            self.dropped = []
            self.created = []

        async def index_information(self):
            return {
                "_id_": {"key": [("_id", 1)], "unique": True},
                "source_key_1": {"key": [("source_key", 1)], "unique": True},
            }

        async def drop_index(self, name):
            self.dropped.append(name)

        async def create_index(self, keys, **options):
            self.created.append((keys, options))

    collection = IndexCollection()
    asyncio.run(server.create_company_unique_index(
        collection, "source_key", unique=True, sparse=True,
    ))

    assert collection.dropped == ["source_key_1"]
    assert collection.created == [(
        [("company_id", 1), ("source_key", 1)],
        {"unique": True, "sparse": True},
    )]


def test_backups_only_request_the_authorized_shared_database():
    assert server.backup_database_names() == [server.base_db.name]


def test_only_iqfoam_profiles_use_the_unified_price_list():
    assert uses_unified_price_list("iqfoam-manufactoring")
    assert uses_unified_price_list("iqfoam-whole-sallers")
    assert not uses_unified_price_list(DEFAULT_COMPANY_ID)


def test_iqfoam_unified_prices_have_one_canonical_zone_and_no_unpriced_sizes():
    simple_sizes = {price["size"] for price in seed_data.IQFOAM_UNIFIED_PRICES if price["category"] == "Simple"}
    ribbon_sizes = {price["size"] for price in seed_data.IQFOAM_UNIFIED_PRICES if price["category"] == "Ribbon Black"}
    assert len(seed_data.IQFOAM_UNIFIED_PRICES) == 44
    assert simple_sizes == {
        "760x50", "760x75", "760x100", "760x120", "760x150",
        "910x50", "910x75", "910x100", "910x120", "910x150",
        "1070x50", "1070x75", "1070x100", "1070x120", "1070x150",
        "1370x50", "1370x75", "1370x100", "1370x120", "1370x150",
    }
    assert ribbon_sizes == {
        "760x100", "760x120", "760x150", "910x100", "910x120", "910x150",
        "1070x100", "1070x120", "1070x150", "1370x100", "1370x120", "1370x150",
    }
    assert {price["size"] for price in seed_data.IQFOAM_UNIFIED_PRICES if price["category"] == "Ribbon Pink"} == ribbon_sizes
    assert {price["category"] for price in seed_data.IQFOAM_UNIFIED_PRICES} == {
        "Simple", "Ribbon Black", "Ribbon Pink",
    }
    assert sum(price["price"] is None for price in seed_data.IQFOAM_UNIFIED_PRICES) == 8
    expected_prices = {
        ("Simple", "760x50"): 105.00,
        ("Simple", "760x100"): 177.00,
        ("Simple", "760x120"): 208.00,
        ("Simple", "760x150"): 265.50,
        ("Simple", "910x100"): 199.00,
        ("Simple", "1070x100"): 215.00,
        ("Simple", "1370x150"): 420.00,
        ("Ribbon Black", "760x100"): 217.00,
        ("Ribbon Pink", "1370x150"): 480.00,
    }
    actual_prices = {
        (price["category"], price["size"]): price["price"]
        for price in seed_data.IQFOAM_UNIFIED_PRICES
    }
    assert all(actual_prices[key] == value for key, value in expected_prices.items())