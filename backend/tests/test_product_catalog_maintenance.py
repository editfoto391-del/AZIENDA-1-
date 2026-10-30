from copy import deepcopy
from types import SimpleNamespace

import pytest

from product_catalog_maintenance import migrate_skus, rollback_skus


class Collection:
    def __init__(self, documents):
        self.documents = deepcopy(documents)

    def find(self, _query):
        return deepcopy(self.documents)

    def find_one(self, query, projection=None):
        return deepcopy(next((item for item in self.documents if item["id"] == query["id"]), None))

    def update_one(self, query, update):
        document = next((item for item in self.documents if item["id"] == query["id"]), None)
        if not document:
            return SimpleNamespace(modified_count=0)
        if "$exists" in query.get("sku", {}) and ("sku" in document) != query["sku"]["$exists"]:
            return SimpleNamespace(modified_count=0)
        if "sku" in query and isinstance(query["sku"], str) and document.get("sku") != query["sku"]:
            return SimpleNamespace(modified_count=0)
        document.update(deepcopy(update.get("$set", {})))
        for field in update.get("$unset", {}):
            document.pop(field, None)
        return SimpleNamespace(modified_count=1)


class Database:
    name = "test_database"

    def __init__(self, documents):
        self.product_identifications = Collection(documents)


@pytest.fixture
def products():
    return Database([
        {
            "id": "identity-1", "company_id": "superiqfoam",
            "product_id": "IQF-ABC123", "qr_payload": "legacy:qr-1",
        },
        {
            "id": "identity-2", "company_id": "iqfoam-manufactoring",
            "product_id": "IQF-DEF456", "qr_payload": "legacy:qr-2",
        },
    ])


def test_sku_migration_snapshots_and_rolls_back_only_added_fields(tmp_path, products):
    result = migrate_skus(products, tmp_path)
    assert result["updated"] == 2
    before = __import__("json").loads(
        (tmp_path / "product-identifications.before-sku-migration.json").read_text()
    )
    assert len(before) == 2
    assert products.product_identifications.documents[0]["qr_payload"] == "legacy:qr-1"
    assert products.product_identifications.documents[1]["qr_payload"] == "legacy:qr-2"

    rollback = rollback_skus(products, tmp_path)
    assert rollback == {"removed": 2, "status": "rolled_back"}
    assert all("sku" not in item for item in products.product_identifications.documents)


def test_sku_rollback_makes_no_changes_when_a_generated_value_was_edited(tmp_path, products):
    migrate_skus(products, tmp_path)
    products.product_identifications.documents[1]["sku"] = "MFG-MANUAL-CHANGE"

    with pytest.raises(RuntimeError, match="Rollback made no changes"):
        rollback_skus(products, tmp_path)

    assert all(item.get("sku") for item in products.product_identifications.documents)
