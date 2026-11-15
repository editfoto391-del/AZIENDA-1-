import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from starlette.requests import Request
from fastapi import Response

import server


def public_order_request():
    path = "/api/public/customer-orders"
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"x-customer-order-token", b"secure-link-token")],
        "client": ("192.0.2.10", 12345),
        "server": ("test", 443),
    })


async def allow_public_rate_limit(*_args, **_kwargs):
    return None


def test_public_order_requires_a_plausible_phone_number():
    with pytest.raises(ValidationError, match="Enter a valid phone number"):
        server.PublicOrderIn(
            name="Acme",
            shop_name="Acme Shop",
            phone="123",
            city="Johannesburg",
            items=[{"qty": 1, "category": "Foam"}],
        )


def test_public_customer_order_routes_keep_token_out_of_the_request_path():
    route_paths = {route.path for route in server.app.routes}

    assert "/api/public/customer-orders" in route_paths
    assert "/api/public/customer-orders/{token}" not in route_paths


def test_public_order_requires_contact_name_shop_name_and_phone():
    with pytest.raises(ValidationError):
        server.PublicOrderIn(
            name="Acme",
            phone="0825550100",
            city="Johannesburg",
            items=[{"qty": 1, "category": "Foam"}],
        )


def test_public_order_matches_phone_after_customer_name_changes():
    customer = {
        "id": "customer-1",
        "name": "Acme Trading",
        "phone": "+27 82 555 0100",
    }

    match, method = server.match_public_order_customer(
        [customer],
        "ACME Tradng",
        "Acme Trading",
        "0825550100",
    )

    assert match == customer
    assert method == "phone"


def test_public_order_matches_a_unique_similar_name_when_customer_has_no_phone():
    customer = {"id": "customer-1", "name": "Acme Trading", "phone": ""}

    match, method = server.match_public_order_customer(
        [customer],
        "Acme Tradng",
        "Acme Trading",
        "0825550100",
    )

    assert match == customer
    assert method == "name"


def test_public_order_uses_unique_similar_name_when_phone_is_different():
    customer = {"id": "customer-1", "name": "Acme Trading", "phone": "0825550199"}

    match, method = server.match_public_order_customer(
        [customer],
        "Acme Tradng",
        "Acme Trading",
        "0825550100",
    )

    assert match == customer
    assert method == "name"


def test_public_order_does_not_auto_match_tied_customer_names():
    customers = [
        {"id": "customer-1", "name": "Acme Trading", "phone": "0825550199"},
        {"id": "customer-2", "name": "Acme Trading", "phone": "0825550188"},
    ]

    match, method = server.match_public_order_customer(
        customers,
        "Acme Trading",
        "Acme Trading",
        "0825550100",
    )

    assert match is None
    assert method == "ambiguous_name"


def test_public_order_links_matching_customer_and_creates_order(monkeypatch):
    stored = []
    existing_customer = {
        "id": "customer-1",
        "name": "Acme Trading",
        "phone": "0825550100",
        "city": "Johannesburg",
        "address": "10 Main Road",
        "email": "orders@example.com",
    }

    class CustomerCollection:
        async def update_one(self, *_args, **_kwargs):
            raise AssertionError("Existing customer contact data should not be overwritten")

    class Orders:
        async def find_one(self, *_args, **_kwargs):
            return None

    async def listall(collection, query, sort=None):
        assert collection == "customers"
        assert server.active_company_id.get() == "superiqfoam"
        return [existing_customer]

    async def insert(collection, data):
        assert server.active_company_id.get() == "superiqfoam"
        record = {"id": f"{collection}-new", **data}
        stored.append((collection, record))
        return record

    async def next_ref(_key, _prefix):
        return "ORD-2026-0001"

    async def emit_workflow_event(*_args):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(customers=CustomerCollection(), orders=Orders()))
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "next_ref", next_ref)
    monkeypatch.setattr(server, "emit_workflow_event", emit_workflow_event)
    monkeypatch.setattr(
        server, "customer_order_company_for_token",
        lambda _token: asyncio.sleep(0, result={"id": "superiqfoam", "name": "SUPERIQFOAM"}),
    )
    monkeypatch.setattr(server, "enforce_public_customer_order_ip_limit", allow_public_rate_limit)
    monkeypatch.setattr(server, "enforce_public_customer_order_rate_limit", allow_public_rate_limit)

    body = server.PublicOrderIn(
        name="Acme Trading Warehouse",
        shop_name="Acme Trading",
        phone="082 555 0100",
        city="Johannesburg",
        items=[{"qty": 2, "category": "Foam", "size": "910x100"}],
    )
    result = asyncio.run(server.submit_public_customer_order(
        body, public_order_request(), Response(),
    ))

    assert result == {"ok": True, "reference": "ORD-2026-0001"}
    assert [collection for collection, _record in stored] == ["orders"]
    order = stored[0][1]
    assert order["customer_id"] == "customer-1"
    assert order["customer_name"] == "Acme Trading"
    assert order["submitted_customer_shop_name"] == "Acme Trading"
    assert order["destination"] == "Johannesburg"
    assert order["status"] == "To Send"
    assert order["items"] == [{
        "qty": 2,
        "category": "Foam",
        "size": "910x100",
        "description": "",
    }]
    assert server.active_company_id.get() is None


def test_public_order_creates_customer_when_no_match_exists(monkeypatch):
    stored = []

    class Orders:
        async def find_one(self, *_args, **_kwargs):
            return None

    async def listall(*_args, **_kwargs):
        return []

    async def insert(collection, data):
        record = {"id": f"{collection}-new", **data}
        stored.append((collection, record))
        return record

    async def next_ref(_key, _prefix):
        return "ORD-2026-0002"

    async def emit_workflow_event(*_args):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(customers=SimpleNamespace(), orders=Orders()))
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "next_ref", next_ref)
    monkeypatch.setattr(server, "emit_workflow_event", emit_workflow_event)
    monkeypatch.setattr(
        server, "customer_order_company_for_token",
        lambda _token: asyncio.sleep(0, result={"id": "superiqfoam", "name": "SUPERIQFOAM"}),
    )
    monkeypatch.setattr(server, "enforce_public_customer_order_ip_limit", allow_public_rate_limit)
    monkeypatch.setattr(server, "enforce_public_customer_order_rate_limit", allow_public_rate_limit)

    result = asyncio.run(server.submit_public_customer_order(
        server.PublicOrderIn(
            name="New Customer",
            shop_name="New Customer Shop",
            phone="0825550101",
            city="Pretoria",
            items=[{"qty": 1, "category": "Foam"}],
        ),
        public_order_request(),
        Response(),
    ))

    assert result == {"ok": True, "reference": "ORD-2026-0002"}
    assert [collection for collection, _record in stored] == ["customers", "orders"]
    customer = stored[0][1]
    assert customer["name"] == "New Customer Shop"
    assert customer["shop_name"] == "New Customer Shop"
    assert customer["contact_name"] == "New Customer"
    assert customer["phone"] == "0825550101"
    assert customer["city"] == "Pretoria"
    assert stored[1][1]["customer_id"] == customer["id"]
    assert stored[1][1]["customer_match_method"] == "new"
    assert stored[1][1]["submitted_customer_shop_name"] == "New Customer Shop"


def test_public_order_submission_id_returns_existing_order_without_creating_data(monkeypatch):
    class Orders:
        async def find_one(self, query, projection):
            assert query["public_submission_id"]
            return {"reference": "ORD-2026-0099"}

    async def find_company(_token):
        return {"id": "superiqfoam", "name": "SUPERIQFOAM"}

    monkeypatch.setattr(server, "db", SimpleNamespace(orders=Orders()))
    monkeypatch.setattr(server, "customer_order_company_for_token", find_company)
    monkeypatch.setattr(server, "enforce_public_customer_order_ip_limit", allow_public_rate_limit)
    monkeypatch.setattr(server, "enforce_public_customer_order_rate_limit", allow_public_rate_limit)

    result = asyncio.run(server.submit_public_customer_order(
        server.PublicOrderIn(
            name="Acme",
            shop_name="Acme Shop",
            phone="0825550100",
            city="Johannesburg",
            items=[{"qty": 1, "category": "Foam"}],
        ),
        public_order_request(),
        Response(),
    ))

    assert result == {"ok": True, "reference": "ORD-2026-0099"}


def test_public_customer_order_link_is_hashed_and_revocable(monkeypatch):
    links = []

    class ShareLinks:
        async def find_one(self, query, projection=None):
            return next((dict(link) for link in links if link.get("id") == query.get("id")), None)

        async def delete_one(self, query):
            before = len(links)
            links[:] = [link for link in links if link.get("id") != query.get("id")]
            return SimpleNamespace(deleted_count=before - len(links))

    async def insert_link(_collection, document):
        links.append(dict(document))
        return document

    async def log_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(customer_order_share_links=ShareLinks()))
    monkeypatch.setattr(server, "insert", insert_link)
    monkeypatch.setattr(server, "log_audit", log_audit)
    user = {"id": "admin-1", "_active_role": "admin", "_active_company_id": "superiqfoam"}
    response = Response()

    token = asyncio.run(server.create_customer_order_share_link(response, user))["token"]
    repeated = asyncio.run(server.create_customer_order_share_link(Response(), user))["token"]

    assert token == repeated
    assert token not in repr(links)
    assert links[0]["token_hash"] == server.worker_access_token_hash(token)
    assert server.decrypt_worker_access_token(links[0]["token_encrypted"]) == token

    revoked = asyncio.run(server.revoke_customer_order_share_link(Response(), user))

    assert revoked == {"revoked": True}
    assert links == []


def test_public_customer_order_link_management_requires_company_admin():
    response = Response()

    with pytest.raises(server.HTTPException) as denied:
        asyncio.run(server.create_customer_order_share_link(
            response,
            {"id": "staff-1", "_active_role": "user", "_active_company_id": "superiqfoam"},
        ))

    assert denied.value.status_code == 403


def test_public_order_form_sets_no_cache_and_no_referrer_headers(monkeypatch):
    async def find_company(_token):
        return {"id": "superiqfoam", "name": "SUPERIQFOAM"}

    monkeypatch.setattr(server, "customer_order_company_for_token", find_company)
    monkeypatch.setattr(server, "enforce_public_customer_order_ip_limit", allow_public_rate_limit)
    response = Response()

    result = asyncio.run(server.get_public_customer_order_form(
        public_order_request(),
        response,
    ))

    assert result == {"company_id": "superiqfoam", "company_name": "SUPERIQFOAM"}
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Robots-Tag"] == "noindex, nofollow"


def test_public_order_link_lookup_uses_hash_and_rejects_bad_tokens(monkeypatch):
    token = server.secrets.token_urlsafe(32)
    lookups = []

    class ShareLinks:
        async def find_one(self, query, projection=None):
            lookups.append(query)
            if query["token_hash"] == server.worker_access_token_hash(token):
                return {"token_hash": query["token_hash"]}
            return None

    class Companies:
        async def find_one(self, query, projection=None):
            return {"id": query["id"]}

    company_database = SimpleNamespace(customer_order_share_links=ShareLinks())
    monkeypatch.setattr(server, "tenant_database", lambda *_args: company_database)
    monkeypatch.setattr(server, "base_db", SimpleNamespace(companies=Companies()))

    profile = asyncio.run(server.customer_order_company_for_token(token))

    assert profile["id"] == server.COMPANY_PROFILES[0]["id"]
    assert lookups[0]["token_hash"] == server.worker_access_token_hash(token)
    assert token not in repr(lookups)

    with pytest.raises(server.HTTPException) as invalid:
        asyncio.run(server.customer_order_company_for_token("superiqfoam"))
    assert invalid.value.status_code == 404


def test_public_order_rate_limit_returns_retry_after(monkeypatch):
    documents = {}

    class Limits:
        async def find_one_and_update(self, query, update, **_kwargs):
            document = documents.setdefault(query["_id"], {"count": 0})
            document["count"] += update["$inc"]["count"]
            document.update(update["$setOnInsert"])
            return dict(document)

    monkeypatch.setattr(server, "base_db", SimpleNamespace(public_customer_order_rate_limits=Limits()))
    now = server.datetime(2026, 11, 15, 16, 0, 30, tzinfo=server.timezone.utc)

    async def scenario():
        await server.enforce_public_customer_order_rate_limit("ip-hash", 1, now=now)
        with pytest.raises(server.HTTPException) as limited:
            await server.enforce_public_customer_order_rate_limit("ip-hash", 1, now=now)
        assert limited.value.status_code == 429
        assert limited.value.headers["Retry-After"] == "30"

    asyncio.run(scenario())


def test_staff_customer_selection_is_recorded_on_public_order(monkeypatch):
    existing = {
        "id": "order-1",
        "reference": "ORD-2026-0003",
        "customer_id": "",
        "source": "public_customer_order",
        "status": "To Send",
        "items": [],
        "products": "",
        "invoice_id": "",
    }
    saved = {}

    class Orders:
        async def find_one(self, *_args, **_kwargs):
            return existing

    class Customers:
        async def find_one(self, query, *_args, **_kwargs):
            assert query == {"id": "customer-2"}
            return {
                "id": "customer-2",
                "name": "Acme Trading",
                "phone": "0825550100",
                "address": "",
                "email": "",
            }

    async def update_doc(_collection, _id, data):
        saved.update(data)
        return {**existing, **data}

    async def emit_workflow_event(*_args):
        return None

    monkeypatch.setattr(server, "db", SimpleNamespace(orders=Orders(), customers=Customers()))
    monkeypatch.setattr(server, "update_doc", update_doc)
    monkeypatch.setattr(server, "emit_workflow_event", emit_workflow_event)
    body = server.OrderIn(customer_id="customer-2", customer_name="Acme Trading")

    asyncio.run(server.edit_order("order-1", body, {"id": "staff-1"}))

    assert saved["customer_id"] == "customer-2"
    assert saved["customer_match_method"] == "manually_assigned"
