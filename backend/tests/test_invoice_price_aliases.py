import asyncio
import re
from types import SimpleNamespace

import pytest

import server


class PriceCollection:
    def __init__(self, records):
        self.records = records
        self.queries = []

    async def find_one(self, query, projection):
        self.queries.append(query)
        return next(
            (
                record
                for record in self.records
                if all(
                    (
                        re.fullmatch(
                            value["$regex"],
                            str(record.get(key, "")),
                            flags=re.IGNORECASE if value.get("$options") == "i" else 0,
                        )
                        if isinstance(value, dict) and "$regex" in value
                        else record.get(key) == value
                    )
                    for key, value in query.items()
                )
            ),
            None,
        )


class InvoiceCollection:
    def __init__(self, invoice):
        self.invoice = invoice

    async def find_one(self, query):
        if self.invoice.get("id") != query.get("id"):
            return None
        return dict(self.invoice)


def resolve(monkeypatch, records, category, size="1000x1000", company="iqfoam-whole-sallers", zone=1):
    prices = PriceCollection(records)
    monkeypatch.setattr(server, "db", SimpleNamespace(prices=prices))
    token = server.active_company_id.set(company)
    try:
        result = asyncio.run(server.resolve_price(zone, category, size))
    finally:
        server.active_company_id.reset(token)
    return result, prices.queries


@pytest.mark.parametrize("company", ["iqfoam-whole-sallers", "iqfoam-manufactoring"])
def test_unified_company_price_lookup_uses_its_own_zone_one_catalog(monkeypatch, company):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Ribbon Black",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 125,
        }],
        "Black fabric",
        company=company,
        zone=2,
    )

    assert result == {"found": True, "price": 125}
    assert queries == [{
        "zone": 1,
        "category": "Ribbon Black",
        "size": "1000x1000",
    }]


def queried_categories(queries):
    categories = []
    for query in queries:
        category = query["category"]
        if isinstance(category, dict):
            category = category["$regex"].strip("^$")
            category = re.sub(r"\\(.)", r"\1", category)
        if category not in categories:
            categories.append(category)
    return categories


@pytest.mark.parametrize(
    "alias",
    ["Black", "Black fabric", "Fabric Black", "Ribbon Balck", "Ribbon Black Fabric"],
)
def test_black_fabric_invoice_alias_resolves_canonical_price(monkeypatch, alias):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Ribbon Black",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 125,
        }],
        alias,
    )

    assert result == {"found": True, "price": 125}
    assert queries == [{
        "zone": 1,
        "category": "Ribbon Black",
        "size": "1000x1000",
    }]


def test_black_fabric_invoice_alias_falls_back_to_legacy_price(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Black fabric",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 130,
        }],
        "Black",
    )

    assert result == {"found": True, "price": 130}
    assert queried_categories(queries) == ["Ribbon Black", "Black", "Black fabric"]


@pytest.mark.parametrize("stored_category", ["black fabric", "BLACK FABRIC", "rIbBoN bAlCk"])
def test_legacy_price_category_case_does_not_block_invoice_issue(monkeypatch, stored_category):
    result, _ = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": stored_category,
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 130,
        }],
        "Black fabric",
    )

    assert result == {"found": True, "price": 130}


def test_case_variant_unconfirmed_canonical_price_does_not_fall_back_to_confirmed_legacy(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [
            {
                "zone": 1,
                "category": "ribbon black",
                "size": "1000x1000",
                "active": True,
                "confirmed": False,
                "price": 125,
            },
            {
                "zone": 1,
                "category": "Black fabric",
                "size": "1000x1000",
                "active": True,
                "confirmed": True,
                "price": 130,
            },
        ],
        "Black",
    )

    assert result["price"] is None
    assert result["needs_config"] is True
    assert len(queries) == 3


def test_ribbon_alias_resolves_legacy_ribbon_pink_price(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Ribbon",
            "size": "760x100",
            "active": True,
            "confirmed": True,
            "price": 217,
        }],
        "Ribbon Pink",
        "760x100",
    )

    assert result == {"found": True, "price": 217}
    assert queried_categories(queries) == ["Ribbon Pink", "Ribbon"]


@pytest.mark.parametrize(
    "stored_size,invoice_size",
    [
        ("910x100", "910 × 100"),
        ("910 × 100", "910x100"),
        ("910 X 100", "910x100"),
    ],
)
def test_equivalent_dimension_formats_resolve_same_price(monkeypatch, stored_size, invoice_size):
    result, _ = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Ribbon Black",
            "size": stored_size,
            "active": True,
            "confirmed": True,
            "price": 239,
        }],
        "Black fabric",
        invoice_size,
    )

    assert result == {"found": True, "price": 239}


def test_unconfirmed_canonical_price_does_not_fall_back_to_legacy_alias(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [
            {
                "zone": 1,
                "category": "Ribbon Black",
                "size": "1000x1000",
                "active": True,
                "confirmed": False,
                "price": 125,
            },
            {
                "zone": 1,
                "category": "Black fabric",
                "size": "1000x1000",
                "active": True,
                "confirmed": True,
                "price": 130,
            },
        ],
        "Black",
    )

    assert result["price"] is None
    assert result["needs_config"] is True
    assert len(queries) == 1


def test_candy_uses_the_same_legacy_price_category_as_the_frontend(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Black fabric",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 130,
        }],
        "Candy",
    )

    assert result == {"found": True, "price": 130}
    assert queried_categories(queries) == ["Ribbon Black", "Black", "Black fabric"]


@pytest.mark.parametrize(
    "category,expected",
    [
        (" SIMPLE/MIX COLOR ", "Simple"),
        ("simple", "Simple"),
        ("STANDARD", "Simple"),
        ("rIbBoN pInK", "Ribbon Pink"),
        (" uncovered blue 16 density ", "Uncovered Blue 16 Density"),
    ],
)
def test_wholesaler_price_category_handles_known_labels_consistently(category, expected):
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        assert server.price_category(1, category) == expected
    finally:
        server.active_company_id.reset(token)


def test_standard_price_category_handles_known_labels_consistently():
    token = server.active_company_id.set("superiqfoam")
    try:
        for category in (" SIMPLE/MIX COLOR ", "simple", "STANDARD"):
            assert server.price_category(1, category) == "Standard"
    finally:
        server.active_company_id.reset(token)


def test_non_unified_black_alias_keeps_manual_only_dimension_rule(monkeypatch):
    result, queries = resolve(
        monkeypatch,
        [{
            "zone": 1,
            "category": "Ribbon Black",
            "size": "1370x150",
            "active": True,
            "confirmed": True,
            "price": 480,
        }],
        "Black fabric",
        "1370 × 150",
        company="superiqfoam",
    )

    assert result["price"] is None
    assert result["needs_config"] is True
    assert queries == []


def test_every_unified_catalog_category_and_size_resolves(monkeypatch):
    records = [
        {
            "zone": 1,
            **price,
            "active": True,
            "confirmed": price["price"] is not None,
        }
        for price in server.seed_data.IQFOAM_UNIFIED_PRICES
    ]
    prices = PriceCollection(records)
    monkeypatch.setattr(server, "db", SimpleNamespace(prices=prices))

    async def resolve_catalog():
        result = []
        for price in server.seed_data.IQFOAM_UNIFIED_PRICES:
            category = price["category"].swapcase()
            result.append((
                price,
                await server.resolve_price(1, category, price["size"]),
            ))
        return result

    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        results = asyncio.run(resolve_catalog())
    finally:
        server.active_company_id.reset(token)

    assert len(results) == 44
    for price, result in results:
        if price["price"] is None:
            assert result["price"] is None
            assert result["needs_config"] is True
        else:
            assert result == {"found": True, "price": price["price"]}


def test_black_fabric_invoice_can_pass_issue_validation(monkeypatch):
    records = [{
        "zone": 1,
        "category": "Ribbon Black",
        "size": "1000x1000",
        "active": True,
        "confirmed": True,
        "price": 125,
    }]
    prices = PriceCollection(records)
    monkeypatch.setattr(server, "db", SimpleNamespace(prices=prices))
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        asyncio.run(server.validate_for_issue({
            "zone": 1,
            "items": [{
                "category": "Black fabric",
                "size": "1000x1000",
                "qty": 1,
                "unit_price": 125,
            }],
        }))
    finally:
        server.active_company_id.reset(token)


def test_existing_zero_price_draft_gets_canonical_price_when_issued(monkeypatch):
    prices = PriceCollection([{
        "zone": 1,
        "category": "Ribbon Black",
        "size": "1000x1000",
        "active": True,
        "confirmed": True,
        "price": 125,
    }])
    monkeypatch.setattr(server, "db", SimpleNamespace(prices=prices))
    invoice = {
        "zone": 1,
        "items": [{
            "category": "Black fabric",
            "size": "1000x1000",
            "qty": 1,
            "unit_price": 0,
            "price_override": False,
        }],
    }
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        asyncio.run(server.validate_for_issue(invoice))
    finally:
        server.active_company_id.reset(token)

    assert invoice["items"][0]["unit_price"] == 125
    assert invoice["items"][0].get("price_override") is False


def test_issue_endpoint_recovers_zero_price_and_issues_existing_draft(monkeypatch):
    invoice = {
        "id": "draft-1",
        "status": "draft",
        "zone": 1,
        "invoice_type": "standard",
        "date": "2026-11-04",
        "items": [{
            "category": "Black fabric",
            "size": "1000x1000",
            "qty": 1,
            "unit_price": 0,
            "price_override": False,
        }],
        "audit": [],
    }
    database = SimpleNamespace(
        prices=PriceCollection([{
            "zone": 1,
            "category": "Ribbon Black",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 125,
        }]),
        invoices=InvoiceCollection(invoice),
    )
    monkeypatch.setattr(server, "db", database)

    async def update_invoice(_collection, _invoice_id, updates):
        invoice.update(updates)
        return dict(invoice)

    async def no_previous_balances(*_args):
        return []

    async def no_workflow_event(*_args):
        return None

    async def invoice_number(*_args):
        return "WHL-2026-0001"

    monkeypatch.setattr(server, "update_doc", update_invoice)
    monkeypatch.setattr(server, "previous_invoice_balances", no_previous_balances)
    monkeypatch.setattr(server, "emit_workflow_event", no_workflow_event)
    monkeypatch.setattr(server, "next_invoice_number", invoice_number)
    monkeypatch.setattr(server, "invoice_numbering_year", lambda _date: 2026)
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        result = asyncio.run(server.issue_invoice(
            "draft-1",
            server.InvoiceIssueIn(),
            {"email": "issuer@example.test"},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result["status"] == "issued"
    assert result["number"] == "WHL-2026-0001"
    assert result["items"][0]["unit_price"] == 125


def test_editing_and_issuing_existing_draft_transitions_to_payable_invoice(monkeypatch):
    invoice = {
        "id": "draft-edit-1",
        "status": "draft",
        "zone": 1,
        "invoice_type": "standard",
        "date": "2026-11-04",
        "customer_name": "Synthetic customer",
        "amount_paid": 0,
        "items": [{
            "category": "Black fabric",
            "size": "1000x1000",
            "qty": 1,
            "unit_price": 0,
            "price_override": False,
        }],
        "audit": [],
    }
    database = SimpleNamespace(
        prices=PriceCollection([{
            "zone": 1,
            "category": "Ribbon Black",
            "size": "1000x1000",
            "active": True,
            "confirmed": True,
            "price": 125,
        }]),
        invoices=InvoiceCollection(invoice),
    )
    monkeypatch.setattr(server, "db", database)

    async def update_invoice(_collection, _invoice_id, updates):
        invoice.update(updates)
        return dict(invoice)

    async def no_op(*_args, **_kwargs):
        return None

    async def no_previous_balances(*_args):
        return []

    async def no_listall(*_args, **_kwargs):
        return []

    async def invoice_number(*_args):
        return "WHL-2026-0002"

    monkeypatch.setattr(server, "update_doc", update_invoice)
    monkeypatch.setattr(server, "consume_invoice_action_authorization", no_op)
    monkeypatch.setattr(server, "previous_invoice_balances", no_previous_balances)
    monkeypatch.setattr(server, "emit_workflow_event", no_op)
    monkeypatch.setattr(server, "log_audit", no_op)
    monkeypatch.setattr(server, "listall", no_listall)
    monkeypatch.setattr(server, "next_invoice_number", invoice_number)
    monkeypatch.setattr(server, "invoice_numbering_year", lambda _date: 2026)
    body = server.InvoiceIn(
        customer_name="Synthetic customer",
        date="2026-11-04",
        made_by="Test",
        status="issued",
        edit_reason="Issue corrected draft",
        items=[{
            "category": "Black fabric",
            "size": "1000x1000",
            "qty": 1,
            "unit_price": 0,
            "price_override": False,
        }],
    )
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        result = asyncio.run(server.update_invoice(
            "draft-edit-1",
            body,
            {"email": "issuer@example.test"},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result["status"] == "issued"
    assert result["number"] == "WHL-2026-0002"
    assert result["items"][0]["unit_price"] == 125


def test_issue_validation_still_rejects_zero_price_without_configured_price(monkeypatch):
    monkeypatch.setattr(server, "db", SimpleNamespace(prices=PriceCollection([])))
    invoice = {
        "zone": 1,
        "items": [{
            "category": "Black fabric",
            "size": "1000x1000",
            "qty": 1,
            "unit_price": 0,
            "price_override": False,
        }],
    }
    token = server.active_company_id.set("iqfoam-whole-sallers")
    try:
        with pytest.raises(server.HTTPException, match="No matching price configured"):
            asyncio.run(server.validate_for_issue(invoice))
    finally:
        server.active_company_id.reset(token)
