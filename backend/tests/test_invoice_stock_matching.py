import asyncio

import pytest
from fastapi import HTTPException

import server


async def resolve_deductions(monkeypatch, stock_items, invoice, company="iqfoam-whole-sallers"):
    async def list_stock(collection, **kwargs):
        assert collection == "stock"
        return stock_items

    monkeypatch.setattr(server, "listall", list_stock)
    token = server.active_company_id.set(company)
    try:
        return await server.invoice_stock_deductions(invoice)
    finally:
        server.active_company_id.reset(token)


@pytest.mark.parametrize(
    "invoice_category,stock_product,stock_size",
    [
        ("Black fabric", "Ribbon Black", "1000 × 1000"),
        ("Ribbon Balck", "Black", "1000x1000"),
        ("Ribbon", "Ribbon Pink", "760 X 100"),
        ("Standard", "Simple", "1070 x 100"),
    ],
)
def test_invoice_stock_matches_category_aliases_and_dimension_formats(
    monkeypatch, invoice_category, stock_product, stock_size
):
    deductions = asyncio.run(resolve_deductions(
        monkeypatch,
        [{
            "id": "stock-1",
            "product": stock_product,
            "size": stock_size,
        }],
        {
            "items": [{
                "category": invoice_category,
                "size": "1000x1000" if invoice_category in ("Black fabric", "Ribbon Balck")
                else "760x100" if invoice_category == "Ribbon"
                else "1070x100",
                "qty": 2,
            }],
        },
    ))

    assert deductions == [{
        "stock_id": "stock-1",
        "product": stock_product,
        "size": stock_size,
        "quantity": server.D("2"),
    }]


def test_invoice_stock_prefers_canonical_product_when_alias_rows_also_exist(monkeypatch):
    deductions = asyncio.run(resolve_deductions(
        monkeypatch,
        [
            {"id": "legacy", "product": "Black", "size": "1000x1000"},
            {"id": "canonical", "product": "Ribbon Black", "size": "1000x1000"},
        ],
        {"items": [{"category": "Black fabric", "size": "1000x1000", "qty": 1}]},
    ))

    assert deductions[0]["stock_id"] == "canonical"


def test_candy_invoice_does_not_deduct_ribbon_black_stock(monkeypatch):
    deductions = asyncio.run(resolve_deductions(
        monkeypatch,
        [{"id": "candy", "product": "Candy", "size": "1000x1000"}],
        {"items": [{"category": "Candy", "size": "1000x1000", "qty": 1}]},
    ))

    assert deductions[0]["stock_id"] == "candy"


def test_invoice_stock_still_rejects_missing_product_size_pair(monkeypatch):
    with pytest.raises(HTTPException) as error:
        asyncio.run(resolve_deductions(
            monkeypatch,
            [{"id": "stock-1", "product": "Ribbon Black", "size": "1000x1000"}],
            {"items": [{"category": "Ribbon Pink", "size": "1000x1000", "qty": 1}]},
        ))

    assert error.value.status_code == 400
    assert error.value.detail == "Stock item not found for invoice line 1: Ribbon Pink 1000x1000"


@pytest.mark.parametrize(
    "stock_product,stock_size,invoice_category,invoice_size",
    [
        ("Brown Spunbond Fabric STD", "Roll A", "BROWN SPUNBOND FABRIC STD", "roll a"),
        ("BROWN\nSPUNBOND FABRIC STD", "SPUNBOND FABRIC STD", "brown spunbond fabric std", "spunbond   fabric std"),
    ],
)
def test_invoice_stock_matches_text_names_and_sizes_case_insensitively(
    monkeypatch, stock_product, stock_size, invoice_category, invoice_size
):
    deductions = asyncio.run(resolve_deductions(
        monkeypatch,
        [{"id": "stock-text", "product": stock_product, "size": stock_size}],
        {"items": [{"category": invoice_category, "size": invoice_size, "qty": 1}]},
    ))

    assert deductions == [{
        "stock_id": "stock-text",
        "product": stock_product,
        "size": stock_size,
        "quantity": server.D("1"),
    }]
