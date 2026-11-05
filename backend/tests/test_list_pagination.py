import asyncio
import re
from copy import deepcopy

import pytest

import server


def matches(document, query):
    def value_of(value):
        if isinstance(value, dict):
            if "$ifNull" in value:
                field, fallback = value["$ifNull"]
                result = value_of(field)
                return fallback if result is None else result
            for operation, operands in value.items():
                if operation == "$gt":
                    return value_of(operands[0]) > value_of(operands[1])
                if operation == "$gte":
                    return value_of(operands[0]) >= value_of(operands[1])
                if operation == "$lte":
                    return value_of(operands[0]) <= value_of(operands[1])
                if operation == "$and":
                    return all(value_of(operand) for operand in operands)
        if isinstance(value, str) and value.startswith("$"):
            return document.get(value[1:])
        return value

    for key, expected in query.items():
        if key == "$and":
            if not all(matches(document, clause) for clause in expected):
                return False
            continue
        if key == "$or":
            if not any(matches(document, clause) for clause in expected):
                return False
            continue
        if key == "$nor":
            if any(matches(document, clause) for clause in expected):
                return False
            continue
        if key == "$expr":
            if not value_of(expected):
                return False
            continue
        value = document.get(key)
        if isinstance(expected, dict):
            if "$regex" in expected:
                options = re.IGNORECASE if "i" in expected.get("$options", "") else 0
                if not re.search(expected["$regex"], str(value or ""), options):
                    return False
            if "$exists" in expected and (key in document) != expected["$exists"]:
                return False
            if "$ne" in expected and value == expected["$ne"]:
                return False
            if "$nin" in expected and value in expected["$nin"]:
                return False
            if "$in" in expected and value not in expected["$in"]:
                return False
            if "$gt" in expected and not (value is not None and value > expected["$gt"]):
                return False
            if "$lt" in expected and not (value is not None and value < expected["$lt"]):
                return False
        elif value != expected:
            return False
    return True


class Cursor:
    def __init__(self, documents, projection):
        self.documents = [deepcopy(document) for document in documents]
        self.projection = projection

    def sort(self, field, direction):
        self.documents.sort(
            key=lambda item: item.get(field) or "",
            reverse=direction < 0,
        )
        return self

    def skip(self, count):
        self.documents = self.documents[count:]
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, length):
        documents = self.documents[:length]
        included = {key for key, enabled in self.projection.items() if enabled and key != "_id"}
        if included:
            return [{key: value for key, value in item.items() if key in included} for item in documents]
        return [
            {key: value for key, value in item.items() if key not in self.projection or self.projection[key]}
            for item in documents
        ]


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]
        self.queries = []

    def find(self, query, projection, **_kwargs):
        self.queries.append(deepcopy(query))
        return Cursor(
            [document for document in self.documents if matches(document, query)],
            projection,
        )

    async def count_documents(self, query):
        self.queries.append(deepcopy(query))
        return sum(matches(document, query) for document in self.documents)


class Database:
    def __init__(self, name, company_id, customers=(), invoices=()):
        self.name = name
        self.customers = Collection(customers)
        self.invoices = Collection(invoices)
        self.invoice_share_links = Collection()

    def __getitem__(self, name):
        return getattr(self, name)


class Client:
    def __init__(self, databases):
        self.databases = databases

    def __getitem__(self, name):
        return self.databases[name]


def scoped_databases():
    company_ids = ("superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers")
    databases = {
        "base": Database("base", "superiqfoam", customers=[
            {"id": "customer-super", "company_id": "superiqfoam", "name": "Super IQ", "phone": "0821234567"},
        ], invoices=[{
            "id": "invoice-super", "company_id": "superiqfoam",
            "invoice_type": "standard", "created_at": "2026-03-01",
        }]),
    }
    for company_id in company_ids[1:]:
        databases[f"base__{company_id}"] = Database(
            f"base__{company_id}",
            company_id,
            customers=[{"id": f"customer-{company_id}", "company_id": company_id, "name": company_id}],
            invoices=[{
                "id": f"invoice-{company_id}", "company_id": company_id,
                "invoice_type": "standard", "created_at": "2026-03-01",
            }],
        )
    return databases


@pytest.mark.parametrize(
    "company_id",
    ["superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers"],
)
def test_customer_pages_are_company_scoped_and_phone_search_spans_the_catalog(monkeypatch, company_id):
    databases = scoped_databases()
    monkeypatch.setattr(server, "db", server.ScopedDatabase(Client(databases), databases["base"]))
    token = server.active_company_id.set(company_id)
    try:
        result = asyncio.run(server.get_customers(
            page=1,
            page_size=50,
            q="0821234567" if company_id == "superiqfoam" else "",
            active_filter="all",
            user={"_active_company_id": company_id},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result["total"] == 1
    assert len(result["items"]) == 1
    assert result["items"][0]["id"] == (
        "customer-super" if company_id == "superiqfoam" else f"customer-{company_id}"
    )
    assert "other_balance_payments" not in result["items"][0]


def test_customer_search_and_active_filter_apply_before_page_and_count(monkeypatch):
    customers = [
        {"id": f"c-{index}", "name": f"Other {index}", "active": True}
        for index in range(60)
    ]
    customers.extend(
        {"id": f"match-{index}", "name": f"John Smith {index}", "phone": "0821234567", "active": index % 2 == 0}
        for index in range(55)
    )
    collection = Collection(customers)
    monkeypatch.setattr(server, "db", type("Database", (), {"customers": collection})())

    result = asyncio.run(server.get_customers(
        page=2,
        page_size=50,
        q="0821234567",
        active_filter="all",
        user={},
    ))
    active_result = asyncio.run(server.get_customers(
        page=1,
        page_size=50,
        q="0821234567",
        active_filter="all",
        user={},
    ))
    active_filtered_result = asyncio.run(server.get_customers(
        page=1,
        page_size=50,
        q="0821234567",
        active_filter="active",
        user={},
    ))

    assert result["total"] == 55
    assert result["page"] == 2
    assert len(result["items"]) == 5
    assert active_result["total"] == 55
    assert len(active_result["items"]) == 50
    assert active_filtered_result["total"] == 28
    assert len(active_filtered_result["items"]) == 28
    assert len(collection.queries) == 6


@pytest.mark.parametrize(
    "company_id",
    ["superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers"],
)
def test_invoice_pages_are_company_scoped(monkeypatch, company_id):
    databases = scoped_databases()
    monkeypatch.setattr(server, "db", server.ScopedDatabase(Client(databases), databases["base"]))
    token = server.active_company_id.set(company_id)
    try:
        result = asyncio.run(server.get_invoices(
            include_archived=False,
            express=False,
            page=1,
            page_size=50,
            q="",
            user={"_active_company_id": company_id},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result["total"] == 1
    expected_id = "invoice-super" if company_id == "superiqfoam" else f"invoice-{company_id}"
    assert [invoice["id"] for invoice in result["items"]] == [expected_id]


def test_invoice_page_filters_search_before_pagination_and_excludes_line_details(monkeypatch):
    invoices = [
        {
            "id": f"other-{index}", "number": f"INV-{index}",
            "customer_name": "Other Customer", "invoice_type": "standard",
            "created_at": f"2026-01-{index % 28 + 1:02d}", "items": [{"qty": 2}],
        }
        for index in range(60)
    ]
    invoices.extend(
        {
            "id": f"match-{index}", "number": f"ACME-{index}",
            "customer_name": "Acme Stores", "invoice_type": "standard",
            "created_at": f"2026-03-{index % 28 + 1:02d}", "date": "2026-03-01",
            "zone": 1, "items": [{"qty": 2}],
        }
        for index in range(55)
    )
    collection = Collection(invoices)
    monkeypatch.setattr(server, "db", type(
        "Database",
        (),
        {"invoices": collection, "invoice_share_links": Collection()},
    )())

    first_page = asyncio.run(server.get_invoices(
        include_archived=False,
        express=False,
        page=1,
        page_size=50,
        q="ACME",
        status="all",
        zone=1,
        invoice_date="2026-03-01",
        user={},
    ))
    result = asyncio.run(server.get_invoices(
        include_archived=False,
        express=False,
        page=2,
        page_size=50,
        q="ACME",
        status="all",
        zone=1,
        invoice_date="2026-03-01",
        user={},
    ))

    assert result["total"] == 55
    assert result["page"] == 2
    assert len(result["items"]) == 5
    assert len(first_page["items"]) == 50
    assert all(item["customer_name"] == "Acme Stores" for item in result["items"])
    assert all("items" not in item for item in result["items"])


def test_invoice_status_filter_matches_existing_derived_status_priority(monkeypatch):
    invoices = [
        {"id": "draft", "status": "draft", "total": 100, "amount_paid": 0, "outstanding": 100},
        {"id": "void", "status": "void", "total": 100, "amount_paid": 0, "outstanding": 100},
        {"id": "paid", "status": "issued", "total": 100, "amount_paid": 100, "outstanding": 0, "due_date": "2026-11-04"},
        {"id": "overdue", "status": "issued", "total": 100, "amount_paid": 25, "outstanding": 75, "due_date": "2026-11-04"},
        {"id": "partial", "status": "issued", "total": 100, "amount_paid": 25, "outstanding": 75, "due_date": "2026-11-06"},
        {"id": "issued", "status": "issued", "total": 100, "amount_paid": 0, "outstanding": 100, "due_date": "2026-11-06"},
    ]
    collection = Collection(invoices)
    monkeypatch.setattr(server, "db", type(
        "Database",
        (),
        {"invoices": collection, "invoice_share_links": Collection()},
    )())

    for status, expected_id in (
        ("draft", "draft"),
        ("void", "void"),
        ("paid", "paid"),
        ("overdue", "overdue"),
        ("partially_paid", "partial"),
        ("issued", "issued"),
    ):
        result = asyncio.run(server.get_invoices(
            include_archived=False,
            express=False,
            page=1,
            page_size=50,
            q="",
            status=status,
            user={},
        ))
        assert [invoice["id"] for invoice in result["items"]] == [expected_id]


def test_unpaginated_customer_and_invoice_routes_keep_their_legacy_response_shape(monkeypatch):
    customers = [{"id": "customer-1", "name": "Customer"}]
    invoices = [{"id": "invoice-1", "invoice_type": "standard", "created_at": "2026-01-01"}]
    monkeypatch.setattr(server, "db", type(
        "Database",
        (),
        {
            "customers": Collection(customers),
            "invoices": Collection(invoices),
            "invoice_share_links": Collection(),
            "__getitem__": lambda self, name: getattr(self, name),
        },
    )())

    customer_result = asyncio.run(server.get_customers(page=None, page_size=50, user={}))
    invoice_result = asyncio.run(server.get_invoices(
        page=None, page_size=50, include_archived=False, express=False, user={},
    ))

    assert isinstance(customer_result, list)
    assert isinstance(invoice_result, list)
    assert customer_result[0]["id"] == "customer-1"
    assert invoice_result[0]["id"] == "invoice-1"
