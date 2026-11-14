import asyncio
from copy import deepcopy

import pytest
from fastapi import HTTPException

import server


def matches(document, query):
    for key, expected in query.items():
        value = document.get(key)
        if isinstance(expected, dict):
            if "$ne" in expected and value == expected["$ne"]:
                return False
        elif value != expected:
            return False
    return True


class Cursor:
    def __init__(self, documents):
        self.documents = [deepcopy(document) for document in documents]

    def sort(self, fields):
        for field, direction in reversed(fields):
            self.documents.sort(
                key=lambda item: item.get(field) or "",
                reverse=direction < 0,
            )
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, length):
        return self.documents[:length]


class Invoices:
    def __init__(self, documents):
        self.documents = documents
        self.query = None

    def find(self, query, _projection):
        self.query = query
        return Cursor([
            invoice for invoice in self.documents
            if matches(invoice, query)
        ])


class Customers:
    async def find_one(self, query, _projection):
        return {"id": query["id"]} if query["id"] == "customer-1" else None


def test_last_invoice_zone_uses_latest_standard_invoice(monkeypatch):
    invoices = Invoices([
        {"customer_id": "customer-1", "zone": 1, "created_at": "2026-01-01"},
        {"customer_id": "customer-1", "zone": 2, "created_at": "2026-02-01"},
        {"customer_id": "customer-1", "zone": 1, "created_at": "2026-03-01", "invoice_type": "express"},
        {"customer_id": "customer-1", "zone": 1, "created_at": "2026-04-01", "status": "void"},
    ])
    monkeypatch.setattr(server, "db", type("DB", (), {
        "customers": Customers(),
        "invoices": invoices,
    })())

    result = asyncio.run(server.get_customer_last_invoice_zone(
        "customer-1",
        user={},
    ))

    assert result == {"zone": 2}
    assert invoices.query["invoice_type"] == {"$ne": "express"}


def test_last_invoice_zone_is_scoped_to_express_invoices(monkeypatch):
    invoices = Invoices([
        {"customer_id": "customer-1", "zone": 2, "created_at": "2026-02-01"},
        {"customer_id": "customer-1", "zone": 1, "created_at": "2026-03-01", "invoice_type": "express"},
    ])
    monkeypatch.setattr(server, "db", type("DB", (), {
        "customers": Customers(),
        "invoices": invoices,
    })())

    result = asyncio.run(server.get_customer_last_invoice_zone(
        "customer-1",
        express=True,
        user={},
    ))

    assert result == {"zone": 1}
    assert invoices.query["invoice_type"] == "express"


def test_last_invoice_zone_rejects_unknown_customer(monkeypatch):
    monkeypatch.setattr(server, "db", type("DB", (), {
        "customers": Customers(),
        "invoices": Invoices([]),
    })())

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.get_customer_last_invoice_zone("unknown", user={}))

    assert error.value.status_code == 404
