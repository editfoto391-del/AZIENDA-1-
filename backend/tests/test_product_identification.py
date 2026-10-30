import asyncio
import re
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import server


def matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(matches(document, clause) for clause in expected):
                return False
        elif isinstance(expected, dict):
            value = document.get(key)
            if "$ne" in expected and value == expected["$ne"]:
                return False
            if "$in" in expected and value not in expected["$in"]:
                return False
            if "$exists" in expected and (key in document) != expected["$exists"]:
                return False
            if "$regex" in expected:
                options = re.IGNORECASE if "i" in expected.get("$options", "") else 0
                if not re.search(expected["$regex"], str(value or ""), options):
                    return False
        elif document.get(key) != expected:
            return False
    return True


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, length):
        return deepcopy(self.documents[:length])


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(item) for item in documents]

    async def find_one(self, query, projection=None):
        document = next((item for item in self.documents if matches(item, query)), None)
        return deepcopy(document) if document else None

    def find(self, query, projection=None):
        return Cursor([item for item in self.documents if matches(item, query)])

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def update_one(self, query, update):
        document = next((item for item in self.documents if matches(item, query)), None)
        if document:
            document.update(deepcopy(update.get("$set", {})))
            for key in update.get("$unset", {}):
                document.pop(key, None)
            return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)


class Database:
    def __init__(self, **collections):
        self.collections = collections

    def __getattr__(self, collection):
        return self.collections[collection]

    def __getitem__(self, collection):
        return self.collections[collection]


def request(path, method="POST"):
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": f"/api/{path}",
        "raw_path": f"/api/{path}".encode(),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 443),
    })


def test_ean13_checksum_validation():
    assert server.valid_ean13("4006381333931")
    assert not server.valid_ean13("4006381333932")
    assert not server.valid_ean13("40063813339A1")
    assert not server.valid_ean13("400638133393")


def test_qr_and_data_matrix_share_the_internal_product_identifier():
    product_id = "IQF-ABC123"
    payload = server.product_code_payload(product_id)
    stock = {"id": "stock-1", "product": "Simple", "size": "910x100"}
    identity = {
        "id": "identity-1", "product_id": product_id, "company_id": "superiqfoam",
        "qr_payload": payload, "data_matrix_payload": payload,
    }

    public = server.public_product_identification(stock, identity)

    assert public["product_id"] == product_id
    assert public["qr_payload"] == public["data_matrix_payload"] == payload
    assert public["sku"].startswith("SFO-")
    assert public["dimensions"] == "910x100"
    assert public["company"] == "SUPERIQFOAM"


def test_duplicate_code_count_ignores_multiple_formats_for_same_product():
    identities = [
        {
            "product_id": "IQF-1",
            "qr_payload": "IQF1:IQF-1",
            "data_matrix_payload": "IQF1:IQF-1",
            "sku": "SFO-1",
        },
        {"product_id": "IQF-2", "sku": "SFO-1", "ean13": "4006381333931"},
    ]

    assert server.duplicate_product_identification_codes(identities) == 1


def test_scanner_lookup_is_company_scoped_and_rejects_inactive_products(monkeypatch):
    identity = {
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-ABC123", "qr_payload": "IQF1:IQF-ABC123",
        "data_matrix_payload": "IQF1:IQF-ABC123", "sku": "SFO-ABC123", "active": True,
    }
    stock = {"id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-ABC123", "product": "Simple",
             "size": "910x100", "opening": 12, "threshold": 2}
    monkeypatch.setattr(server, "base_db", Database(
        product_identifications=Collection([identity]),
    ))
    monkeypatch.setattr(server, "db", Database(
        stock=Collection([stock]),
        stock_movements=Collection(),
    ))

    async def verify_lookups():
        found_stock, found_identity = await server.resolve_product_scan(
            "iqf1:iqf-abc123", {"_active_company_id": "superiqfoam"}
        )
        assert found_identity["product_id"] == found_stock["product_id"] == "IQF-ABC123"
        assert found_stock["current"] == 12
        _, found_by_sku = await server.resolve_product_scan(
            "sfo-abc123", {"_active_company_id": "superiqfoam"}
        )
        assert found_by_sku["product_id"] == "IQF-ABC123"

        with pytest.raises(HTTPException) as error:
            await server.resolve_product_scan(
                "IQF1:IQF-ABC123", {"_active_company_id": "iqfoam-whole-sallers"}
            )
        assert error.value.status_code == 404

        monkeypatch.setattr(server, "base_db", Database(
            product_identifications=Collection([{**identity, "active": False}]),
        ))
        with pytest.raises(HTTPException) as error:
            await server.resolve_product_scan(
                "IQF1:IQF-ABC123", {"_active_company_id": "superiqfoam"}
            )
        assert error.value.status_code == 410

    asyncio.run(verify_lookups())


def test_worker_product_scanning_requires_an_authorized_erp_section():
    invoice_worker = {
        "is_worker": True, "worker_allowed_sections": ["invoices"],
        "worker_stock_only": False,
    }
    server.enforce_worker_api_access(request("products/scan"), invoice_worker)

    unauthorized_worker = {
        "is_worker": True, "worker_allowed_sections": ["expenses"],
        "worker_stock_only": False,
    }
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request("products/scan"), unauthorized_worker)
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request("products", method="GET"), unauthorized_worker)
    assert error.value.status_code == 403
    server.enforce_worker_api_access(request("products", method="GET"), {
        "is_worker": True, "worker_allowed_sections": ["stock"], "worker_stock_only": False,
    })


def test_stock_workers_can_read_selling_prices_but_not_edit_them():
    stock_worker = {
        "is_worker": True,
        "worker_allowed_sections": ["stock"],
        "worker_stock_only": False,
    }

    server.enforce_worker_api_access(request("prices", method="GET"), stock_worker)
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request("prices", method="POST"), stock_worker)
    assert error.value.status_code == 403

    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request("prices", method="GET"), {
            "is_worker": True, "worker_allowed_sections": ["expenses"], "worker_stock_only": False,
        })
    assert error.value.status_code == 403


def test_all_workers_are_hidden_from_stock_costs_and_cannot_change_them(monkeypatch):
    worker = {"is_worker": True, "worker_stock_only": False}
    stock = {"id": "stock-1", "product": "Simple", "size": "910x100", "unit_cost": 77.25}
    returned_stock = server.stock_for_user(deepcopy(stock), worker)
    assert "unit_cost" not in returned_stock

    captured_update = {}
    async def count_movements(_query):
        return 0

    async def find_stock(_query, _projection):
        return deepcopy(stock)

    async def update_doc(_collection, _stock_id, values):
        captured_update.update(values)
        return {**stock, **values}

    async def log_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(
        stock=SimpleNamespace(find_one=find_stock),
        stock_movements=SimpleNamespace(count_documents=count_movements),
    ))
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "log_audit", log_audit)

    result = asyncio.run(server.edit_stock(
        "stock-1",
        server.StockIn(product="Simple", size="910x100", opening=0, threshold=5, unit_cost=0.01),
        worker,
    ))

    assert "unit_cost" not in captured_update
    assert "unit_cost" not in result
    assert stock["unit_cost"] == 77.25


def test_internal_product_identifier_is_generated_once_and_ignores_client_company():
    stock = {"id": "stock-1", "product": "Simple", "size": "910x100"}
    identity_collection = Collection()
    stock_collection = Collection([stock])
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identity_collection))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection))

    async def create_twice():
        existing_stock = await stock_collection.find_one({"id": "stock-1"})
        first = await server.ensure_product_identification(existing_stock, "superiqfoam")
        existing_stock = await stock_collection.find_one({"id": "stock-1"})
        second = await server.ensure_product_identification(existing_stock, "superiqfoam")
        return first, second, existing_stock

    try:
        first, second, saved_stock = asyncio.run(create_twice())
    finally:
        monkeypatch.undo()

    assert first["product_id"] == second["product_id"] == saved_stock["product_id"]
    assert first["product_id"].startswith("IQF-")
    assert first["company_id"] == "superiqfoam"
    assert len(identity_collection.documents) == 1
    untrusted = server.ProductIdentificationIn.model_validate({
        "company_id": "iqfoam-whole-sallers", "active": True,
    })
    assert "company_id" not in untrusted.model_dump()


def test_existing_product_identifiers_are_never_regenerated_or_overwritten():
    original = {
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-LEGACY-ID", "qr_payload": "legacy:keep-exactly",
        "data_matrix_payload": "legacy-dm", "active": True,
    }
    identities = Collection([original])
    stock_collection = Collection([{
        "id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-LEGACY-ID",
        "product": "Simple", "size": "910x100",
    }])
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identities))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection))

    async def load_existing():
        return await server.ensure_product_identification(
            await stock_collection.find_one({"id": "stock-1"}), "superiqfoam"
        )

    try:
        identity = asyncio.run(load_existing())
    finally:
        monkeypatch.undo()

    assert identity["product_id"] == "IQF-LEGACY-ID"
    assert identity["qr_payload"] == "legacy:keep-exactly"
    assert identity["data_matrix_payload"] == "legacy-dm"
    assert identities.documents[0] == original


def test_identifier_mismatch_is_reported_instead_of_overwriting_product_id():
    identities = Collection([{
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-CATALOG-ID", "qr_payload": "IQF1:IQF-CATALOG-ID",
    }])
    stock_collection = Collection([{
        "id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-STOCK-ID",
        "product": "Simple", "size": "910x100",
    }])
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identities))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection))

    async def load_existing():
        await server.ensure_product_identification(
            await stock_collection.find_one({"id": "stock-1"}), "superiqfoam"
        )

    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(load_existing())
    finally:
        monkeypatch.undo()
    assert error.value.status_code == 409
    assert stock_collection.documents[0]["product_id"] == "IQF-STOCK-ID"


def test_scan_endpoint_returns_the_company_stock_and_records_a_scan(monkeypatch):
    identity = {
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-ABC123", "qr_payload": "IQF1:IQF-ABC123",
        "data_matrix_payload": "IQF1:IQF-ABC123", "active": True,
    }
    stock = {"id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-ABC123",
             "product": "Simple", "size": "910x100", "opening": 12, "threshold": 2}
    scans = Collection()
    monkeypatch.setattr(server, "base_db", Database(
        product_identifications=Collection([identity]), product_scans=scans,
    ))
    monkeypatch.setattr(server, "db", Database(
        stock=Collection([stock]), stock_movements=Collection(),
    ))

    result = asyncio.run(server.scan_product(
        server.ProductScanIn(code="IQF1:IQF-ABC123", scan_id="scan-once"),
        {"id": "worker-1", "_active_company_id": "superiqfoam"},
    ))

    assert result["stock_id"] == "stock-1"
    assert result["current_stock"] == 12
    assert len(scans.documents) == 1
    assert scans.documents[0]["company_id"] == "superiqfoam"
    assert scans.documents[0]["code_type"] == "qr"
    assert scans.documents[0]["user_id"] == "worker-1"


def test_paginated_product_list_is_filtered_to_the_active_company(monkeypatch):
    identities = Collection([
        {
            "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
            "product_id": "IQF-ABC123", "sku": "SFO-ABC123", "qr_payload": "IQF1:IQF-ABC123",
            "data_matrix_payload": "IQF1:IQF-ABC123", "category": "Foam", "density": "16",
            "active": True,
        },
        {
            "id": "identity-2", "company_id": "superiqfoam", "stock_id": "stock-2",
            "product_id": "IQF-DEF456", "sku": "SFO-DEF456", "qr_payload": "IQF1:IQF-DEF456",
            "data_matrix_payload": "IQF1:IQF-DEF456", "category": "Foam", "active": False,
        },
        {
            "id": "identity-other", "company_id": "iqfoam-whole-sallers", "stock_id": "stock-other",
            "product_id": "IQF-OTHER", "sku": "WHL-OTHER", "qr_payload": "IQF1:IQF-OTHER",
            "data_matrix_payload": "IQF1:IQF-OTHER", "category": "Foam", "active": True,
        },
    ])
    stock_collection = Collection([
        {"id": "stock-1", "product": "Simple", "size": "910x100"},
        {"id": "stock-2", "product": "Simple", "size": "910x120"},
        {"id": "stock-other", "product": "Simple", "size": "910x150"},
    ])
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identities))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection))

    result = asyncio.run(server.list_products(
        q="", category="foam", density=None, active=True, page=1, page_size=1,
        user={"_active_company_id": "superiqfoam"},
    ))

    assert result["total"] == 1
    assert result["pages"] == 1
    assert len(result["items"]) == 1
    assert result["items"][0]["company_id"] == "superiqfoam"
    assert result["items"][0]["product_id"] == "IQF-ABC123"


def test_product_metadata_edit_keeps_product_and_qr_ids_immutable(monkeypatch):
    identity = {
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-ABC123", "qr_payload": "IQF1:IQF-ABC123",
        "data_matrix_payload": "IQF1:IQF-ABC123", "active": True,
    }
    identity_collection = Collection([identity])
    stock_collection = Collection([{
        "id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-ABC123",
        "product": "Simple", "size": "910x100",
    }])
    audit = Collection()
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identity_collection))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection, audit_log=audit))

    updated = asyncio.run(server.update_stock_product_identification(
        "stock-1",
        server.ProductIdentificationIn(
            sku="sfo-custom-01", category="Finished foam", length=910,
            width=100, unit="mm", data_matrix_payload="DM:ABC123",
        ),
        {"_active_company_id": "superiqfoam", "email": "owner@example.test"},
    ))

    assert updated["sku"] == "SFO-CUSTOM-01"
    assert updated["category"] == "Finished foam"
    assert updated["length"] == 910
    assert updated["width"] == 100
    assert updated["unit"] == "mm"
    assert updated["product_id"] == "IQF-ABC123"
    assert updated["qr_payload"] == "IQF1:IQF-ABC123"
    assert updated["data_matrix_payload"] == "DM:ABC123"
    assert audit.documents[0]["action"] == "updated"


def test_stock_product_details_require_admin_and_preserve_catalog_identity(monkeypatch):
    identity_collection = Collection([{
        "id": "identity-1", "company_id": "superiqfoam", "stock_id": "stock-1",
        "product_id": "IQF-ABC123", "qr_payload": "IQF1:IQF-ABC123",
    }])
    stock_collection = Collection([{
        "id": "stock-1", "company_id": "superiqfoam", "product_id": "IQF-ABC123",
        "product": "Simple", "size": "910x100",
    }])
    audit = Collection()
    monkeypatch.setattr(server, "base_db", Database(product_identifications=identity_collection))
    monkeypatch.setattr(server, "db", Database(stock=stock_collection, audit_log=audit))

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.update_stock_product_details(
            "stock-1",
            server.ProductStockDetailsIn(product="Premium Foam", dimensions="910x100x50"),
            {"_active_company_id": "superiqfoam", "_active_role": "user"},
        ))
    assert error.value.status_code == 403

    updated = asyncio.run(server.update_stock_product_details(
        "stock-1",
        server.ProductStockDetailsIn(product="Premium Foam", dimensions=" 910x100x50 "),
        {"_active_company_id": "superiqfoam", "_active_role": "admin", "email": "admin@example.test"},
    ))

    assert updated["product"] == "Premium Foam"
    assert updated["dimensions"] == "910x100x50"
    assert updated["product_id"] == "IQF-ABC123"
    assert updated["qr_payload"] == "IQF1:IQF-ABC123"
    assert stock_collection.documents[0]["product"] == "Premium Foam"
    assert audit.documents[0]["action"] == "product_details_updated"


def test_ean_must_be_validated_before_it_can_be_registered():
    registered = server.ProductIdentificationIn(
        ean13="4006381333931", gs1_allocated=True
    )
    assert registered.ean13 == "4006381333931"

    with pytest.raises(ValueError, match=re.escape("valid check digit")):
        server.ProductIdentificationIn(ean13="4006381333932", gs1_allocated=True)


def test_product_metadata_validation_and_sku_normalization():
    product = server.ProductIdentificationIn(
        sku=" sfo-simple-01 ", category="Foam", length="910", width=120,
        thickness=50, unit="mm", data_matrix_payload="DM:ABC",
    )
    assert product.sku == "SFO-SIMPLE-01"
    assert product.length == 910
    assert product.width == 120
    assert product.unit == "mm"

    with pytest.raises(ValueError, match="positive finite numbers"):
        server.ProductIdentificationIn(thickness=float("nan"))
    with pytest.raises(ValueError, match="SKU"):
        server.ProductIdentificationIn(sku="unsafe sku")
    with pytest.raises(ValueError, match="numeric"):
        server.ProductStockDetailsIn(product="Simple", dimensions="unknown")
