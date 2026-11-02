import asyncio
from copy import deepcopy

import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient

import server


class FakeCollection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        found = next(
            (document for document in self.documents
             if all(document.get(key) == value for key, value in query.items())),
            None,
        )
        return deepcopy(found) if found else None

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def delete_one(self, query):
        found = next(
            (document for document in self.documents
             if all(document.get(key) == value for key, value in query.items())),
            None,
        )
        if found:
            self.documents.remove(found)
        return type("DeleteResult", (), {"deleted_count": int(found is not None)})()


class FakeDatabase:
    def __init__(self):
        self.invoices = FakeCollection([{
            "id": "invoice-1",
            "number": "100",
            "customer_id": "customer-1",
            "customer_name": "Test Customer",
            "status": "issued",
            "date": "2026-11-01",
            "due_date": "2026-11-30",
            "items": [{
                "category": "Foam", "size": "Single", "qty": 1, "unit_price": 10,
                "stock_id": "internal-stock-id",
            }],
            "amount_paid": 0,
            "audit": [{"private": "audit data"}],
            "payment_records": [{"private": "payment data"}],
        }])
        self.invoice_share_links = FakeCollection()
        self.customers = FakeCollection([{
            "id": "customer-1",
            "address": "1 Main Road",
            "city": "Kokstad",
            "phone": "+27601234567",
            "email": "customer@example.test",
            "notes": "private customer note",
        }])
        self.settings = FakeCollection([{
            "id": "singleton",
            "company_name": "SUPER IQ-FOAM",
            "address": "Business address",
            "telephone": "0123",
            "tax_number": "123",
            "secret": "private settings",
        }])
        self.audit_log = FakeCollection()

    def __getattr__(self, name):
        return self.__dict__[name]

    def __getitem__(self, name):
        return getattr(self, name)


async def no_audit(*args, **kwargs):
    return None


@pytest.fixture
def share_database(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "tenant_database", lambda *args: database)
    monkeypatch.setattr(server, "log_audit", no_audit)
    return database


def test_invoice_share_link_is_stable_and_only_returns_invoice_document_data(share_database):
    database = share_database

    async def scenario():
        token = await server.issue_invoice_share_link("invoice-1", {"email": "owner@example.test"})
        repeated_token = await server.issue_invoice_share_link("invoice-1", {"email": "owner@example.test"})
        assert repeated_token == token

        stored_link = database.invoice_share_links.documents[0]
        assert token not in repr(stored_link)
        assert stored_link["token_hash"] == server.worker_access_token_hash(token)

        shared = await server.get_public_invoice_share(token, Response())
        assert shared["invoice"]["number"] == "100"
        assert shared["invoice"]["total"] == 10
        assert shared["customer"]["phone"] == "+27601234567"
        assert "audit" not in shared["invoice"]
        assert "payment_records" not in shared["invoice"]
        assert "stock_id" not in shared["invoice"]["items"][0]
        assert "notes" not in shared["customer"]
        assert "secret" not in shared["settings"]

    asyncio.run(scenario())


def test_invoice_share_link_rejects_drafts_and_revocation_removes_public_access(share_database):
    database = share_database
    database.invoices.documents[0]["status"] = "draft"

    async def scenario():
        with pytest.raises(HTTPException) as draft_error:
            await server.issue_invoice_share_link("invoice-1", {"email": "owner@example.test"})
        assert draft_error.value.status_code == 400

        database.invoices.documents[0]["status"] = "issued"
        token = await server.issue_invoice_share_link("invoice-1", {"email": "owner@example.test"})
        result = await server.revoke_invoice_share_link("invoice-1", {"email": "owner@example.test"})
        assert result == {"revoked": True}

        with pytest.raises(HTTPException) as revoked_error:
            await server.get_public_invoice_share(token, Response())
        assert revoked_error.value.status_code == 404

    asyncio.run(scenario())


def test_public_invoice_share_route_returns_document_without_authentication(share_database):
    database = share_database
    token = asyncio.run(server.issue_invoice_share_link(
        "invoice-1", {"email": "owner@example.test"},
    ))

    response = TestClient(server.app).get(f"/api/public/invoices/{token}")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-robots-tag"] == "noindex, nofollow"
    assert response.json()["invoice"]["number"] == "100"
    assert database.invoice_share_links.documents
