import asyncio
from copy import deepcopy
import re
from types import SimpleNamespace

import pytest
from bson import ObjectId
from fastapi.encoders import jsonable_encoder
from fastapi import HTTPException

import server


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, *_args):
        return self

    def skip(self, count):
        self.documents = self.documents[count:]
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, length=None):
        return deepcopy(self.documents if length is None else self.documents[:length])


def matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(matches(document, option) for option in expected):
                return False
            continue
        actual = document.get(key)
        if isinstance(expected, dict):
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$regex" in expected:
                flags = re.IGNORECASE if "i" in expected.get("$options", "") else 0
                if actual is None or re.search(expected["$regex"], str(actual), flags) is None:
                    return False
        elif actual != expected:
            return False
    return True


class Collection:
    def __init__(self, documents=()):
        self.documents = deepcopy(list(documents))

    def find(self, query=None, _projection=None):
        return Cursor([document for document in self.documents if matches(document, query or {})])

    async def find_one(self, query, _projection=None):
        return deepcopy(next((document for document in self.documents if matches(document, query)), None))

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def count_documents(self, query):
        return sum(matches(document, query) for document in self.documents)

    async def update_one(self, query, update, **_kwargs):
        document = next((row for row in self.documents if matches(row, query)), None)
        if not document:
            return SimpleNamespace(matched_count=0)
        document.update(deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1)


class ObjectIdOnInsertCollection(Collection):
    async def insert_one(self, document):
        document["_id"] = ObjectId()
        return await super().insert_one(document)

class AtomicCollection(Collection):
    async def find_one_and_update(self, query, update, **_kwargs):
        document = next(
            (row for row in self.documents if matches(row, query)),
            None,
        )
        if not document:
            return None
        document.update(deepcopy(update.get("$set", {})))
        document.setdefault("audit", []).append(deepcopy(update["$push"]["audit"]))
        return deepcopy(document)


class UpsertCollection(Collection):
    async def update_one(self, query, update, **kwargs):
        document = next((row for row in self.documents if matches(row, query)), None)
        if document:
            document.update(deepcopy(update.get("$set", {})))
            return SimpleNamespace(matched_count=1, upserted_id=None)
        if kwargs.get("upsert"):
            document = deepcopy(update.get("$setOnInsert", {}))
            document.update(deepcopy(update.get("$set", {})))
            self.documents.append(document)
            return SimpleNamespace(matched_count=0, upserted_id=document.get("id"))
        return SimpleNamespace(matched_count=0, upserted_id=None)


class Database:
    def __init__(self, **collections):
        self.collections = collections

    def __getattr__(self, name):
        return self.collections[name]


@pytest.mark.parametrize(
    "user",
    [
        {"id": "requester", "role": "owner"},
        {"id": "requester-admin", "company_roles": {"superiqfoam": "admin"}},
    ],
)
def test_request_creation_snapshots_only_supplier_stock_and_rejects_duplicate_lines(monkeypatch, user):
    supplier_db = Database(stock=Collection([{
        "id": "supplier-stock-1",
        "company_id": "iqfoam-whole-sallers",
        "product": "Foam",
        "size": "100x200",
        "opening": 12,
    }]), product_identifications=Collection())
    shared_db = Database(
        intercompany_order_requests=ObjectIdOnInsertCollection(),
        product_identifications=Collection(),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(
        server, "intercompany_available_stock",
        lambda *_args: asyncio.sleep(0, result={"supplier-stock-1": 8}),
    )
    monkeypatch.setattr(server, "notify_intercompany_company", lambda *_args, **_kwargs: asyncio.sleep(0))
    company_token = server.active_company_id.set("superiqfoam")
    try:
        body = server.IntercompanyOrderRequestIn(
            supplying_company_id="iqfoam-whole-sallers",
            items=[{"stock_id": "supplier-stock-1", "quantity": 3}],
        )
        request = asyncio.run(server.create_intercompany_request(body, user))
        assert "_id" not in request
        jsonable_encoder(request)
        assert request["status"] == "PENDING"
        assert request["requesting_company_id"] == "superiqfoam"
        assert request["supplying_company_id"] == "iqfoam-whole-sallers"
        assert request["items"][0]["available_quantity_at_request"] == 8
        assert request["items"][0]["quantity"] == 3
        assert request["items"][0]["manual_review"] is True
        assert supplier_db.stock.documents[0]["opening"] == 12

        duplicate_body = server.IntercompanyOrderRequestIn(
            supplying_company_id="iqfoam-whole-sallers",
            items=[
                {"stock_id": "supplier-stock-1", "quantity": 1},
                {"stock_id": "supplier-stock-1", "quantity": 2},
            ],
        )
        with pytest.raises(HTTPException) as duplicate:
            asyncio.run(server.create_intercompany_request(duplicate_body, user))
        assert duplicate.value.status_code == 400
        assert duplicate.value.detail == "Combine repeated product lines into one quantity"
    finally:
        server.active_company_id.reset(company_token)


def test_intercompany_supplier_catalog_returns_active_company_stock_and_category(monkeypatch):
    supplier_db = Database(stock=Collection([{
        "id": "supplier-stock-1",
        "company_id": "superiqfoam",
        "product": "Simple",
        "size": "760x50",
        "opening": 12,
    }]))
    shared_db = Database(product_identifications=Collection([{
        "company_id": "superiqfoam",
        "stock_id": "supplier-stock-1",
        "product_type": "Standard",
        "description": "Standard foam",
        "active": True,
    }]))
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(
        server,
        "intercompany_available_stock",
        lambda *_args: asyncio.sleep(0, result={"supplier-stock-1": 8}),
    )
    company_token = server.active_company_id.set("superiqfoam")
    try:
        catalog = asyncio.run(server.get_intercompany_supplier_catalog(
            q="Standard",
            page=1,
            page_size=100,
            user={"id": "supplier-admin", "company_roles": {"superiqfoam": "admin"}},
        ))
        assert catalog["items"] == [{
            "stock_id": "supplier-stock-1",
            "product": "Simple",
            "product_type": "Standard",
            "dimensions": "760x50",
            "description": "Standard foam",
            "available_quantity": 8,
        }]
    finally:
        server.active_company_id.reset(company_token)


def test_request_access_is_company_scoped_and_invoice_details_are_hidden_until_sent(monkeypatch):
    request = {
        "id": "ICR-1",
        "requesting_company_id": "superiqfoam",
        "supplying_company_id": "iqfoam-whole-sallers",
        "invoice_id": "invoice-1",
        "invoice_number": "INV-1",
        "invoice_total": 100,
        "invoice_sent": False,
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    monkeypatch.setattr(server, "base_db", shared_db)
    user = {"id": "requester-admin", "company_roles": {"superiqfoam": "admin"}}
    company_token = server.active_company_id.set("superiqfoam")
    try:
        visible = asyncio.run(server.get_intercompany_request("ICR-1", user))
        assert "invoice_id" not in visible
        assert "invoice_number" not in visible
        assert "invoice_total" not in visible
    finally:
        server.active_company_id.reset(company_token)

    company_token = server.active_company_id.set("iqfoam-manufactoring")
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server.get_intercompany_request("ICR-1", user))
        assert error.value.status_code == 403
    finally:
        server.active_company_id.reset(company_token)

    request["invoice_sent"] = True
    assert server.public_intercompany_request(request, "superiqfoam")["invoice_id"] == "invoice-1"


def test_intercompany_notifications_reach_admins_authorized_for_the_supplier_company():
    accounts = [
        {"id": "manufacturing-admin", "company_roles": {"iqfoam-manufactoring": "admin"}},
        {"id": "manufacturing-user", "company_roles": {"iqfoam-manufactoring": "user"}},
        {"id": "other-company-admin", "company_roles": {"superiqfoam": "admin"}},
        {"id": "wholesaler-admin", "company_roles": {"iqfoam-whole-sallers": "admin"}},
        {
            "id": "manufacturing-worker",
            "company_roles": {"iqfoam-manufactoring": "admin"},
            "is_worker": True,
        },
        {
            "id": "inactive-admin",
            "company_roles": {"iqfoam-manufactoring": "admin"},
            "active": False,
        },
    ]

    recipients = server.intercompany_notification_recipients(
        accounts, "iqfoam-manufactoring",
    )

    assert {account["id"] for account in recipients} == {
        "manufacturing-admin", "wholesaler-admin",
    }


def test_acceptance_rejects_unreviewed_or_insufficient_stock_without_mutation(monkeypatch):
    request = {
        "id": "ICR-2",
        "requesting_company_id": "superiqfoam",
        "supplying_company_id": "iqfoam-whole-sallers",
        "status": "PENDING",
        "created_by": "requester",
        "supplying_company_name": "IQFOAM WHOLESALERS",
        "items": [{
            "id": "item-1",
            "stock_id": "supplier-stock-1",
            "product": "Foam",
            "dimensions": "100x200",
            "quantity": 4,
            "manual_review": True,
        }],
    }
    request_collection = Collection([request])
    monkeypatch.setattr(server, "base_db", Database(intercompany_order_requests=request_collection))
    monkeypatch.setattr(
        server, "tenant_database",
        lambda *_args: Database(stock=Collection([])),
    )
    monkeypatch.setattr(server, "notify_intercompany_company", lambda *_args, **_kwargs: asyncio.sleep(0))
    user = {"id": "supplier-admin", "company_roles": {"iqfoam-whole-sallers": "admin"}}
    company_token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        with pytest.raises(HTTPException) as unreviewed:
            asyncio.run(server.accept_intercompany_request("ICR-2", user))
        assert unreviewed.value.status_code == 409
        assert request_collection.documents[0]["status"] == "PENDING"

        request_collection.documents[0]["items"][0]["manual_review"] = False
        monkeypatch.setattr(
            server, "intercompany_available_stock",
            lambda *_args: asyncio.sleep(0, result={"supplier-stock-1": 3}),
        )
        with pytest.raises(HTTPException) as shortage:
            asyncio.run(server.accept_intercompany_request("ICR-2", user))
        assert shortage.value.status_code == 409
        assert request_collection.documents[0]["status"] == "PENDING"
        assert request_collection.documents[0]["items"][0]["quantity"] == 4
    finally:
        server.active_company_id.reset(company_token)


def test_acceptance_relinks_recreated_supplier_stock_item(monkeypatch):
    request = {
        "id": "ICR-RELINK",
        "requesting_company_id": "superiqfoam",
        "supplying_company_id": "iqfoam-whole-sallers",
        "status": "PENDING",
        "created_by": "requester",
        "supplying_company_name": "IQFOAM WHOLESALERS",
        "items": [{
            "id": "item-1",
            "stock_id": "deleted-stock-item",
            "product": "Ribbon Pink",
            "dimensions": "1070x120",
            "quantity": 1,
            "manual_review": False,
        }],
    }
    request_collection = AtomicCollection([request])
    supplier_db = Database(stock=Collection([{
        "id": "recreated-stock-item",
        "company_id": "iqfoam-whole-sallers",
        "product": "Ribbon Pink",
        "size": "1070x120",
        "opening": 5,
        "archived": False,
    }]))
    monkeypatch.setattr(
        server, "base_db",
        Database(intercompany_order_requests=request_collection),
    )
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(
        server,
        "intercompany_available_stock",
        lambda _db, _company, stock_ids: asyncio.sleep(0, result={
            stock_id: 5 for stock_id in stock_ids
            if stock_id == "recreated-stock-item"
        }),
    )
    monkeypatch.setattr(
        server, "notify_intercompany_company",
        lambda *_args, **_kwargs: asyncio.sleep(0),
    )
    user = {"id": "supplier-admin", "company_roles": {"iqfoam-whole-sallers": "admin"}}
    company_token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        accepted = asyncio.run(server.accept_intercompany_request("ICR-RELINK", user))
        assert accepted["status"] == "ACCEPTED"
        assert accepted["items"][0]["stock_id"] == "recreated-stock-item"
        assert accepted["audit"][-1]["stock_relinked_items"] == [{
            "item_id": "item-1",
            "previous_stock_id": "deleted-stock-item",
            "stock_id": "recreated-stock-item",
        }]
    finally:
        server.active_company_id.reset(company_token)


def test_invoice_stock_deductions_use_in_stock_matching_product_record(monkeypatch):
    stock_records = [
        {"id": "recreated-stock", "product": "Ribbon Pink", "size": "1070x120"},
        {"id": "old-stock", "product": "Ribbon Pink", "size": "1070x120"},
    ]
    async def list_stock(collection, **_kwargs):
        assert collection == "stock"
        return deepcopy(stock_records)

    monkeypatch.setattr(server, "listall", list_stock)

    async def stock_current(stock):
        stock["current"] = 1 if stock["id"] == "recreated-stock" else 0
        return stock

    monkeypatch.setattr(server, "stock_current", stock_current)
    deductions = asyncio.run(server.invoice_stock_deductions({
        "items": [{
            "category": "Ribbon Pink",
            "size": "1070x120",
            "qty": 1,
        }],
    }))

    assert deductions == [{
        "stock_id": "recreated-stock",
        "product": "Ribbon Pink",
        "size": "1070x120",
        "quantity": server.D("1"),
    }]


@pytest.mark.parametrize(
    "company_id",
    ["superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers"],
)
def test_intercompany_permissions_respect_existing_company_roles(company_id):
    user = {"id": "company-admin", "company_roles": {company_id: "admin"}}
    token = server.active_company_id.set(company_id)
    try:
        server.require_intercompany_company_access(user, company_id, administrator=True)
        other_company = next(
            candidate for candidate in (
                "superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers",
            ) if candidate != company_id
        )
        if company_id == "iqfoam-whole-sallers":
            server.require_intercompany_company_access(user, other_company)
        else:
            with pytest.raises(HTTPException) as error:
                server.require_intercompany_company_access(user, other_company)
            assert error.value.status_code == 403
    finally:
        server.active_company_id.reset(token)


def test_invoice_creation_requires_prices_before_creating_a_new_invoice(monkeypatch):
    request = {
        "id": "ICR-3",
        "requesting_company_id": "superiqfoam",
        "supplying_company_id": "iqfoam-whole-sallers",
        "status": "ACCEPTED",
        "items": [{
            "id": "request-line-3",
            "stock_id": "supplier-stock-1",
            "product": "Foam",
            "dimensions": "100x200",
            "quantity": 2,
        }],
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    supplier_db = Database(
        invoices=Collection(),
        intercompany_customer_mappings=Collection([{
            "requesting_company_id": "superiqfoam",
            "company_id": "iqfoam-whole-sallers",
            "customer_id": "customer-1",
        }]),
        customers=Collection([{
            "id": "customer-1",
            "company_id": "iqfoam-whole-sallers",
            "name": "SUPER IQFOAM",
            "active": True,
        }]),
        intercompany_prices=Collection(),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(
        server, "resolve_price",
        lambda *_args: asyncio.sleep(0, result={"found": False, "price": None}),
    )
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server.create_intercompany_invoice(
                "ICR-3",
                server.IntercompanyCreateInvoiceIn(send_to_requesting_company=False),
                {"id": "supplier-admin", "company_roles": {"iqfoam-whole-sallers": "admin"}},
            ))
        assert error.value.status_code == 409
        assert "No confirmed saved price" in error.value.detail
        assert supplier_db.invoices.documents == []
    finally:
        server.active_company_id.reset(token)


def test_intercompany_invoice_uses_saved_price_and_customer_zone_rules(monkeypatch):
    request = {
        "id": "ICR-5",
        "requesting_company_id": "iqfoam-whole-sallers",
        "supplying_company_id": "superiqfoam",
        "status": "ACCEPTED",
        "items": [{
            "id": "request-line-1",
            "stock_id": "supplier-stock-1",
            "product": "Simple",
            "dimensions": "760x50",
            "quantity": 2,
        }],
        "invoice_sent": False,
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    supplier_db = Database(
        invoices=Collection(),
        intercompany_customer_mappings=Collection(),
        customers=Collection([{
            "id": "customer-1",
            "company_id": "superiqfoam",
            "name": "IQFOAM WHOLESALERS",
            "default_zone": 2,
            "active": True,
        }]),
        prices=Collection([
            {"zone": 1, "category": "Standard", "size": "760x50", "price": 85, "active": True, "confirmed": True},
            {"zone": 2, "category": "Standard", "size": "760x50", "price": 95, "active": True, "confirmed": True},
        ]),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(server, "db", supplier_db)

    created_invoices = []

    async def create_saved_invoice(body, user):
        created_invoices.append(body)
        return {"id": "invoice-5", "number": "INV-5", "total": 170}

    monkeypatch.setattr(server, "create_invoice", create_saved_invoice)
    user = {"id": "supplier-admin", "company_roles": {"superiqfoam": "admin"}}
    token = server.active_company_id.set("superiqfoam")
    try:
        result = asyncio.run(server.create_intercompany_invoice(
            "ICR-5",
            server.IntercompanyCreateInvoiceIn(
                send_to_requesting_company=False,
                items=[server.IntercompanyInvoiceLineIn(item_id="request-line-1", quantity=5)],
            ),
            user,
        ))
        assert result["invoice"]["id"] == "invoice-5"
        assert created_invoices[0].zone == 1
        assert created_invoices[0].made_by
        assert created_invoices[0].deduct_stock is True
        assert created_invoices[0].items[0].unit_price == 85
        assert created_invoices[0].items[0].qty == 5
        assert created_invoices[0].items[0].unit_price * created_invoices[0].items[0].qty == 425
        assert created_invoices[0].customer_id == ""
        assert created_invoices[0].customer_name == "IQFOAM WHOLESALERS"
        assert shared_db.intercompany_order_requests.documents[0]["invoice_quantities"] == {
            "request-line-1": 5,
        }
    finally:
        server.active_company_id.reset(token)


def test_intercompany_invoice_uses_requesting_company_name_without_customer_record(monkeypatch):
    request = {
        "id": "ICR-NO-CUSTOMER",
        "requesting_company_id": "imraan-plastics",
        "supplying_company_id": "superiqfoam",
        "status": "ACCEPTED",
        "items": [{
            "id": "request-line",
            "stock_id": "supplier-stock",
            "product": "Ribbon Pink",
            "dimensions": "1070x120",
            "quantity": 1,
        }],
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    supplier_db = Database(
        invoices=Collection(),
        intercompany_customer_mappings=Collection(),
        customers=Collection(),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(
        server,
        "resolve_price",
        lambda *_args: asyncio.sleep(0, result={"found": True, "price": 100}),
    )
    created_invoices = []

    async def create_saved_invoice(body, user):
        created_invoices.append(body)
        return {"id": "invoice-no-customer", "number": "INV-IC", "total": 100}

    monkeypatch.setattr(server, "create_invoice", create_saved_invoice)
    user = {"id": "supplier-admin", "company_roles": {"superiqfoam": "admin"}}
    token = server.active_company_id.set("superiqfoam")
    try:
        result = asyncio.run(server.create_intercompany_invoice(
            "ICR-NO-CUSTOMER",
            server.IntercompanyCreateInvoiceIn(send_to_requesting_company=False),
            user,
        ))

        assert result["invoice"]["id"] == "invoice-no-customer"
        assert created_invoices[0].customer_id == ""
        assert created_invoices[0].customer_name == "IMRAAN PLASTICS"
    finally:
        server.active_company_id.reset(token)


def test_intercompany_invoice_can_add_supplier_stock_product(monkeypatch):
    request = {
        "id": "ICR-ADD-PRODUCT",
        "requesting_company_id": "iqfoam-whole-sallers",
        "supplying_company_id": "superiqfoam",
        "status": "ACCEPTED",
        "items": [{
            "id": "request-line-1",
            "stock_id": "requested-stock",
            "product": "Simple",
            "dimensions": "760x50",
            "quantity": 2,
        }],
        "invoice_sent": False,
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    supplier_db = Database(
        invoices=Collection(),
        intercompany_customer_mappings=Collection(),
        customers=Collection([{
            "id": "customer-1",
            "company_id": "superiqfoam",
            "name": "IQFOAM WHOLESALERS",
            "default_zone": 2,
            "active": True,
        }]),
        stock=Collection([{
            "id": "added-stock",
            "company_id": "superiqfoam",
            "product": "Simple",
            "size": "900x50",
            "opening": 10,
        }]),
        prices=Collection(),
    )
    shared_db.product_identifications = Collection([{
        "company_id": "superiqfoam",
        "stock_id": "added-stock",
        "product_type": "Standard",
        "description": "Additional foam product",
        "active": True,
    }])
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(server, "db", supplier_db)
    monkeypatch.setattr(
        server, "resolve_price",
        lambda _zone, _category, _size: asyncio.sleep(0, result={
            "found": True, "price": 85,
        }),
    )
    created_invoices = []

    async def create_saved_invoice(body, user):
        created_invoices.append(body)
        return {"id": "invoice-added-product", "number": "INV-ADD", "total": 595}

    monkeypatch.setattr(server, "create_invoice", create_saved_invoice)
    user = {"id": "supplier-admin", "company_roles": {"superiqfoam": "admin"}}
    token = server.active_company_id.set("superiqfoam")
    try:
        with pytest.raises(HTTPException) as invalid_stock:
            asyncio.run(server.create_intercompany_invoice(
                "ICR-ADD-PRODUCT",
                server.IntercompanyCreateInvoiceIn(
                    send_to_requesting_company=False,
                    items=[
                        server.IntercompanyInvoiceLineIn(item_id="request-line-1", quantity=5),
                        server.IntercompanyInvoiceLineIn(stock_id="other-company-stock", quantity=2),
                    ],
                ),
                user,
            ))
        assert invalid_stock.value.status_code == 400
        assert "supplier stock" in invalid_stock.value.detail
        assert created_invoices == []

        asyncio.run(server.create_intercompany_invoice(
            "ICR-ADD-PRODUCT",
            server.IntercompanyCreateInvoiceIn(
                send_to_requesting_company=False,
                items=[
                    server.IntercompanyInvoiceLineIn(item_id="request-line-1", quantity=5),
                    server.IntercompanyInvoiceLineIn(stock_id="added-stock", quantity=2),
                ],
            ),
            user,
        ))
        added_line = created_invoices[0].items[1]
        assert added_line.category == "Standard"
        assert added_line.size == "900x50"
        assert added_line.description == "Additional foam product"
        assert added_line.qty == 2
        assert added_line.unit_price == 85
    finally:
        server.active_company_id.reset(token)


@pytest.mark.parametrize(
    ("supplier_id", "requester_id", "customer_zone", "expected_zone"),
    [
            ("superiqfoam", "iqfoam-whole-sallers", 2, 1),
            ("superiqfoam", "iqfoam-manufactoring", 2, 2),
            ("iqfoam-manufactoring", "superiqfoam", 2, 1),
            ("iqfoam-whole-sallers", "superiqfoam", 2, 1),
    ],
)
def test_intercompany_prices_choose_saved_company_zone(
    supplier_id, requester_id, customer_zone, expected_zone,
):
    assert server.intercompany_price_zone(
            supplier_id, requester_id, {"default_zone": customer_zone},
    ) == expected_zone


def test_requesting_company_can_preview_sent_invoice_with_supplier_document_details(monkeypatch):
    request = {
        "id": "ICR-PREVIEW",
        "requesting_company_id": "iqfoam-whole-sallers",
        "supplying_company_id": "superiqfoam",
        "invoice_id": "invoice-preview",
        "invoice_sent": True,
    }
    invoice = {
        "id": "invoice-preview",
        "intercompany_request_id": "ICR-PREVIEW",
        "customer_id": "customer-preview",
        "customer_name": "IQFOAM WHOLESALERS",
        "number": "INV-2026-001",
        "date": "2026-11-01",
        "due_date": "2026-11-01",
        "zone": 1,
        "items": [{"qty": 2, "category": "Standard", "size": "760x50", "unit_price": 100}],
        "status": "issued",
        "amount_paid": 0,
    }
    shared_db = Database(intercompany_order_requests=Collection([request]))
    supplier_db = Database(
        invoices=Collection([invoice]),
        payments=Collection([
            {"invoice_id": "invoice-preview", "amount": 25},
            {"invoice_id": "invoice-preview", "amount": 100, "reversed": True},
            {"invoice_id": "invoice-preview", "amount": 100, "archived": True},
        ]),
        settings=Collection([{
            "id": "singleton",
            "company_name": "SUPER IQ FOAM",
            "address": "Supplier address",
            "telephone": "0123456789",
            "banking_details": "Supplier bank details",
            "supervisor_password_hash": "must-not-be-returned",
        }]),
        customers=Collection([{
            "id": "customer-preview",
            "company_id": "superiqfoam",
            "address": "Customer address",
            "city": "Customer city",
            "phone": "0123456789",
            "email": "customer@example.test",
        }]),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        result = asyncio.run(server.get_intercompany_request_invoice(
            "ICR-PREVIEW", {"id": "wholesaler-admin", "role": "owner"},
        ))
        assert result["invoice"]["total"] == 200
        assert result["invoice"]["amount_paid"] == 25
        assert result["invoice"]["outstanding"] == 175
        assert result["settings"]["company_name"] == "SUPER IQ FOAM"
        assert result["settings"]["unified_price_list"] is False
        assert result["customer"]["address"] == "Customer address"
        assert "supervisor_password_hash" not in result["settings"]
    finally:
        server.active_company_id.reset(token)


@pytest.mark.parametrize(
    "request_invoice_id, invoice_link",
    [
        ("invoice-legacy", None),
        (None, "idempotency_key"),
    ],
)
def test_sent_intercompany_invoice_repairs_legacy_linkage_on_access(
    monkeypatch, request_invoice_id, invoice_link,
):
    request = {
        "id": "ICR-LEGACY",
        "requesting_company_id": "iqfoam-whole-sallers",
        "supplying_company_id": "superiqfoam",
        "invoice_id": request_invoice_id,
        "invoice_sent": True,
    }
    invoice = {
        "id": "invoice-legacy",
        "number": "INV-LEGACY",
        "date": "2026-11-01",
        "total": 200,
        "items": [],
    }
    if invoice_link:
        invoice[invoice_link] = "intercompany:ICR-LEGACY"
    requests = Collection([request])
    invoices = Collection([invoice])
    shared_db = Database(intercompany_order_requests=requests)
    supplier_db = Database(
        invoices=invoices,
        payments=Collection(),
        settings=Collection(),
        customers=Collection(),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        result = asyncio.run(server.get_intercompany_request_invoice(
            "ICR-LEGACY", {"id": "wholesaler-admin", "role": "owner"},
        ))
        assert result["invoice"]["id"] == "invoice-legacy"
        assert invoices.documents[0]["intercompany_request_id"] == "ICR-LEGACY"
        assert requests.documents[0]["invoice_id"] == "invoice-legacy"
    finally:
        server.active_company_id.reset(token)


def test_sent_intercompany_invoice_does_not_resolve_invoice_linked_to_another_request(monkeypatch):
    request = {
        "id": "ICR-LEGACY",
        "requesting_company_id": "iqfoam-whole-sallers",
        "supplying_company_id": "superiqfoam",
        "invoice_id": "invoice-legacy",
        "invoice_sent": True,
    }
    invoice = {
        "id": "invoice-legacy",
        "intercompany_request_id": "ICR-OTHER",
        "items": [],
    }
    supplier_db = Database(
        invoices=Collection([invoice]),
        payments=Collection(),
        settings=Collection(),
        customers=Collection(),
    )
    monkeypatch.setattr(
        server, "base_db",
        Database(intercompany_order_requests=Collection([request])),
    )
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server.get_intercompany_request_invoice(
                "ICR-LEGACY", {"id": "wholesaler-admin", "role": "owner"},
            ))
        assert error.value.status_code == 404
    finally:
        server.active_company_id.reset(token)


def test_direct_intercompany_invoice_send_is_idempotent_and_received_by_recipient(monkeypatch):
    invoice = {
        "id": "invoice-direct",
        "number": "INV-DIRECT",
        "status": "issued",
        "items": [{"qty": 2, "unit_price": 50, "category": "Foam", "size": "100x200"}],
    }
    deliveries = UpsertCollection()
    shared_db = Database(
        intercompany_order_requests=Collection(),
        intercompany_invoice_deliveries=deliveries,
    )
    sender_db = Database(invoices=Collection([invoice]))
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda _client, _base, company_id: sender_db)
    monkeypatch.setattr(server, "notify_intercompany_company", lambda *_args, **_kwargs: asyncio.sleep(0))
    user = {"id": "sender-admin", "role": "owner"}
    token = server.active_company_id.set("superiqfoam")
    try:
        body = server.IntercompanyInvoiceSendIn(
            invoice_id="invoice-direct",
            recipient_company_id="iqfoam-whole-sallers",
        )
        first = asyncio.run(server.send_intercompany_invoice(body, user))
        second = asyncio.run(server.send_intercompany_invoice(body, user))
        assert first["invoice_id"] == "invoice-direct"
        assert second["id"] == first["id"]
        assert len(deliveries.documents) == 1
        assert deliveries.documents[0]["recipient_company_id"] == "iqfoam-whole-sallers"
    finally:
        server.active_company_id.reset(token)


def test_direct_intercompany_invoice_appears_in_recipient_receiving_invoices(monkeypatch):
    request_db = Database(
        intercompany_order_requests=Collection([{
            "id": "ICR-RECEIVED",
            "requesting_company_id": "iqfoam-whole-sallers",
            "supplying_company_id": "iqfoam-manufactoring",
            "invoice_id": "invoice-requested",
            "invoice_number": "INV-REQUESTED",
            "invoice_total": 75,
            "invoice_sent": True,
            "sent_at": "2026-11-18T08:00:00+00:00",
        }]),
        intercompany_invoice_deliveries=Collection([{
            "id": "direct-delivery",
            "sender_company_id": "superiqfoam",
            "recipient_company_id": "iqfoam-whole-sallers",
            "invoice_id": "invoice-direct",
            "sent_at": "2026-11-18T09:00:00+00:00",
        }]),
    )
    sender_db = Database(invoices=Collection([{
        "id": "invoice-direct",
        "number": "INV-DIRECT",
        "total": 100,
        "customer_name": "IQFOAM WHOLESALERS",
    }]))
    monkeypatch.setattr(server, "base_db", request_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: sender_db)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        receipts = asyncio.run(server.list_received_intercompany_invoices(
            {"id": "recipient-admin", "role": "owner"},
        ))
        assert receipts == [{
            "id": "direct:direct-delivery",
            "source": "direct",
            "requesting_company_id": "iqfoam-whole-sallers",
            "supplying_company_id": "superiqfoam",
            "invoice_id": "invoice-direct",
            "invoice_number": "INV-DIRECT",
            "invoice_total": 100,
            "customer_name": "IQFOAM WHOLESALERS",
            "sent_at": "2026-11-18T09:00:00+00:00",
        }, {
            "id": "request:ICR-RECEIVED",
            "source": "request",
            "requesting_company_id": "iqfoam-whole-sallers",
            "supplying_company_id": "iqfoam-manufactoring",
            "invoice_id": "invoice-requested",
            "invoice_number": "INV-REQUESTED",
            "invoice_total": 75,
            "sent_at": "2026-11-18T08:00:00+00:00",
        }]
    finally:
        server.active_company_id.reset(token)


def test_direct_intercompany_invoice_details_are_only_available_to_recipient(monkeypatch):
    delivery = {
        "id": "superiqfoam:iqfoam-whole-sallers:invoice-direct",
        "sender_company_id": "superiqfoam",
        "recipient_company_id": "iqfoam-whole-sallers",
        "invoice_id": "invoice-direct",
    }
    invoice = {
        "id": "invoice-direct",
        "customer_name": "IQFOAM WHOLESALERS",
        "number": "INV-DIRECT",
        "date": "2026-11-18",
        "due_date": "2026-11-18",
        "items": [{"qty": 2, "category": "Foam", "size": "100x200", "unit_price": 50}],
        "status": "issued",
        "amount_paid": 0,
    }
    shared_db = Database(
        intercompany_order_requests=Collection(),
        intercompany_invoice_deliveries=Collection([delivery]),
    )
    sender_db = Database(
        invoices=Collection([invoice]),
        payments=Collection(),
        settings=Collection(),
        customers=Collection(),
    )
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: sender_db)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        received = asyncio.run(server.get_received_intercompany_invoice(
            "direct:superiqfoam:iqfoam-whole-sallers:invoice-direct",
            {"id": "recipient-admin", "role": "owner"},
        ))
        assert received["source"] == "direct"
        assert received["invoice_details"]["invoice"]["number"] == "INV-DIRECT"
    finally:
        server.active_company_id.reset(token)

    token = server.active_company_id.set("iqfoam-manufactoring")
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server.get_received_intercompany_invoice(
                "direct:superiqfoam:iqfoam-whole-sallers:invoice-direct",
                {"id": "other-admin", "role": "owner"},
            ))
        assert error.value.status_code == 404
    finally:
        server.active_company_id.reset(token)


def test_invoice_retry_reuses_existing_invoice_and_only_releases_after_send(monkeypatch):
    request = {
        "id": "ICR-4",
        "requesting_company_id": "superiqfoam",
        "supplying_company_id": "iqfoam-whole-sallers",
        "requesting_company_name": "SUPERIQFOAM",
        "supplying_company_name": "IQFOAM WHOLESALERS",
        "status": "ACCEPTED",
        "created_by": "requester",
        "items": [],
        "invoice_sent": False,
    }
    invoice = {
        "id": "invoice-4",
        "number": "INV-4",
        "date": "2026-11-01",
        "total": 250,
        "idempotency_key": "intercompany:ICR-4",
        "intercompany_request_id": "ICR-4",
    }
    requests = Collection([request])
    shared_db = Database(intercompany_order_requests=requests)
    supplier_db = Database(invoices=Collection([invoice]))
    monkeypatch.setattr(server, "base_db", shared_db)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: supplier_db)
    monkeypatch.setattr(server, "notify_intercompany_company", lambda *_args, **_kwargs: asyncio.sleep(0))
    monkeypatch.setattr(server, "create_invoice", lambda *_args, **_kwargs: pytest.fail("invoice retry created a duplicate"))
    user = {"id": "supplier-admin", "company_roles": {"iqfoam-whole-sallers": "admin"}}
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        created = asyncio.run(server.create_intercompany_invoice(
            "ICR-4",
            server.IntercompanyCreateInvoiceIn(send_to_requesting_company=False),
            user,
        ))
        assert created["invoice"]["id"] == "invoice-4"
        assert created["sent"] is False
        assert requests.documents[0]["status"] == "INVOICE_CREATED"
        assert requests.documents[0]["invoice_sent"] is False

        sent = asyncio.run(server.create_intercompany_invoice(
            "ICR-4",
            server.IntercompanyCreateInvoiceIn(send_to_requesting_company=True),
            user,
        ))
        assert sent["invoice"]["id"] == "invoice-4"
        assert sent["sent"] is True
        assert requests.documents[0]["status"] == "INVOICE_SENT"
        assert requests.documents[0]["invoice_sent"] is True
    finally:
        server.active_company_id.reset(token)
