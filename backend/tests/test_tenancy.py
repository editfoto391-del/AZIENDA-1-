import pytest

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
        return (self.name, name)


class FakeClient:
    def __getitem__(self, name):
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


def test_existing_database_remains_superiqfoam_and_others_are_separate():
    client = FakeClient()
    base = FakeDatabase()
    assert tenant_database(client, base, DEFAULT_COMPANY_ID) is base
    manufacturing_db = tenant_database(client, base, "iqfoam-manufactoring")
    wholesalers_db = tenant_database(client, base, "iqfoam-whole-sallers")
    assert manufacturing_db.name == "iqfoam__iqfoam-manufactaring"
    assert wholesalers_db.name == "iqfoam__iqfoam-whole-sallers"
    assert manufacturing_db.name != wholesalers_db.name


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