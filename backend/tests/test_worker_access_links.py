import asyncio
import re
from copy import deepcopy

import pytest
from fastapi import HTTPException, Response
from starlette.requests import Request

import server


def matches(document, query):
    for key, expected in query.items():
        if key == "$or":
            if not any(matches(document, clause) for clause in expected):
                return False
            continue
        actual = document
        for part in key.split("."):
            actual = actual.get(part) if isinstance(actual, dict) else None
        if isinstance(expected, dict):
            if "$ne" in expected and actual == expected["$ne"]:
                return False
            if "$in" in expected and actual not in expected["$in"]:
                return False
            if "$regex" in expected and not re.search(expected["$regex"], str(actual or ""), re.I):
                return False
        elif actual != expected:
            return False
    return True


class FakeCursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, length):
        return deepcopy(self.documents[:length])


class FakeCollection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        found = next((document for document in self.documents if matches(document, query)), None)
        return deepcopy(found) if found else None

    def find(self, query, projection=None):
        return FakeCursor([document for document in self.documents if matches(document, query)])

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def update_one(self, query, update):
        document = next((item for item in self.documents if matches(item, query)), None)
        if document:
            document.update(deepcopy(update.get("$set", {})))
        return type("UpdateResult", (), {"matched_count": int(document is not None)})()

    async def delete_many(self, query):
        self.documents[:] = [item for item in self.documents if not matches(item, query)]


class FakeDatabase:
    def __init__(self, documents):
        self.collections = {
            "users": FakeCollection(documents),
            "user_sessions": FakeCollection(),
            "companies": FakeCollection([
                {"id": profile["id"], "active": True} for profile in server.COMPANY_PROFILES
            ]),
        }

    def __getattr__(self, name):
        return self.collections[name]

    def __getitem__(self, name):
        return self.collections[name]


def request(path, token, method="GET"):
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 443),
    })


@pytest.mark.parametrize("section", ["invoices", "stock"])
def test_workers_can_access_only_their_own_notification_routes(section):
    worker = {"is_worker": True, "worker_allowed_sections": [section]}

    for path, method in (
        ("/api/notifications", "GET"),
        ("/api/notifications/notification-1/read", "POST"),
        ("/api/notifications/notification-1/dismiss", "POST"),
        ("/api/notifications/dismiss-all", "POST"),
    ):
        server.enforce_worker_api_access(request(path, "unused", method), worker)

    with pytest.raises(HTTPException) as unrelated_section:
        server.enforce_worker_api_access(request("/api/fleet", "unused"), worker)
    assert unrelated_section.value.status_code == 403


def test_workers_need_explicit_grv_access_and_production_access_stays_independent():
    production_worker = {"is_worker": True, "worker_allowed_sections": ["production"]}
    server.enforce_worker_api_access(request("/api/production/daily", "unused"), production_worker)
    with pytest.raises(HTTPException) as production_cannot_access_grv:
        server.enforce_worker_api_access(request("/api/grv", "unused"), production_worker)
    assert production_cannot_access_grv.value.status_code == 403

    costs_worker = {"is_worker": True, "worker_allowed_sections": ["costs"]}
    with pytest.raises(HTTPException) as costs_cannot_access_grv:
        server.enforce_worker_api_access(request("/api/grv", "unused"), costs_worker)
    assert costs_cannot_access_grv.value.status_code == 403

    grv_worker = {"is_worker": True, "worker_allowed_sections": ["grv"]}
    server.enforce_worker_api_access(request("/api/grv", "unused"), grv_worker)


def test_yellow_navigation_pages_require_their_individual_worker_sections():
    cases = (
        ("/api/intercompany/requests", "intercompany", "orders"),
        ("/api/company-inventory", "company-inventory", "stock"),
        ("/api/warehouses/A/reports", "warehouse-a", "warehouse-b"),
        ("/api/warehouses/chemical/logs", "chemical-usage-log", "chemicals-quantity"),
    )
    for path, granted_section, denied_section in cases:
        company_id = "superiqfoam" if granted_section.startswith(("chemical-", "chemicals-")) else "iqfoam-manufactoring"
        worker = {
            "is_worker": True,
            "worker_allowed_sections": [granted_section],
            "_active_company_id": company_id,
        }
        server.enforce_worker_api_access(request(path, "unused"), worker)
        worker["worker_allowed_sections"] = [denied_section]
        with pytest.raises(HTTPException) as denied:
            server.enforce_worker_api_access(request(path, "unused"), worker)
        assert denied.value.status_code == 403

    chemical_usage_worker = {
        "is_worker": True,
        "worker_allowed_sections": ["chemical-usage-log"],
        "_active_company_id": "superiqfoam",
    }
    server.enforce_worker_api_access(
        request("/api/warehouses/chemical/inventory", "unused"),
        chemical_usage_worker,
    )

    manufacturing_chemical_worker = {
        "is_worker": True,
        "worker_allowed_sections": ["warehouse-chemical"],
        "_active_company_id": "iqfoam-manufactoring",
    }
    server.enforce_worker_api_access(
        request("/api/warehouses/chemical/logs", "unused"),
        manufacturing_chemical_worker,
    )
    server.enforce_worker_api_access(
        request("/api/warehouses/chemical/inventory", "unused"),
        manufacturing_chemical_worker,
    )


def test_chemical_routes_require_the_matching_company_specific_section():
    cases = (
        ("superiqfoam", "chemical-usage-log", "/api/warehouses/chemical/logs"),
        ("iqfoam-manufactoring", "warehouse-chemical", "/api/warehouses/chemical/logs"),
        ("superiqfoam", "chemicals-quantity", "/api/warehouses/chemical/inventory"),
        ("iqfoam-manufactoring", "warehouse-chemical-inventory", "/api/warehouses/chemical/inventory"),
    )
    for company_id, section, path in cases:
        worker = {
            "is_worker": True,
            "worker_allowed_sections": [section],
            "_active_company_id": company_id,
        }
        server.enforce_worker_api_access(request(path, "unused"), worker)

    with pytest.raises(HTTPException) as wrong_chemical_page:
        server.enforce_worker_api_access(request("/api/warehouses/chemical/inventory", "unused", "POST"), {
            "is_worker": True,
            "worker_allowed_sections": ["warehouse-chemical"],
            "_active_company_id": "iqfoam-manufactoring",
        })
    assert wrong_chemical_page.value.status_code == 403


def test_manufacturing_worker_supervisor_configuration_is_validated():
    W = ("warehouses",)
    assert server.worker_supervisor_settings(
        "iqfoam-manufactoring", True, ["C", "B"], ["invoice_edit"], W,
    ) == (["B", "C"], ["invoice_edit"])
    assert server.worker_supervisor_settings(
        "superiqfoam", False, [], [],
    ) == ([], [])
    assert server.worker_supervisor_settings("iqfoam-manufactoring", False, [], []) == ([], [])

    with pytest.raises(HTTPException) as warehouse_in_other_company:
        server.worker_supervisor_settings("superiqfoam", False, ["A"], [], W)
    assert warehouse_in_other_company.value.status_code == 400

    with pytest.raises(HTTPException) as invalid_warehouse:
        server.worker_supervisor_settings("iqfoam-manufactoring", False, ["Z"], [], W)
    assert invalid_warehouse.value.status_code == 400

    with pytest.raises(HTTPException) as action_without_supervisor:
        server.worker_supervisor_settings(
            "iqfoam-manufactoring", False, ["A"], ["price_edit"], W,
        )
    assert action_without_supervisor.value.status_code == 400


def test_worker_write_permissions_are_enforced_by_section_and_operation():
    permissions = {
        "invoices": {"create": "deny", "update": "supervisor", "delete": "deny"},
    }
    worker = {
        "is_worker": True,
        "worker_allowed_sections": ["invoices"],
        "worker_write_permissions": permissions,
    }
    assert server.worker_write_scope("/api/invoices/inv-1/payments", "POST") == (
        "client-payments", "create",
    )
    assert server.worker_write_scope("/api/invoices/inv-1", "PUT") == ("invoices", "update")

    with pytest.raises(HTTPException) as denied_create:
        server.enforce_worker_api_access(request("/api/invoices", "unused", "POST"), worker)
    assert denied_create.value.status_code == 403

    server.enforce_worker_api_access(request("/api/invoices/inv-1", "unused", "PUT"), worker)

    with pytest.raises(HTTPException) as missing_delete_permission:
        server.enforce_worker_api_access(request("/api/invoices/inv-1", "unused", "DELETE"), worker)
    assert missing_delete_permission.value.status_code == 403


def test_worker_supervisor_permission_is_scoped_to_company_and_action(monkeypatch):
    class GrantCollection:
        async def delete_one(self, query):
            self.query = query
            return type("DeleteResult", (), {"deleted_count": 1})()

    class GrantDatabase:
        supervisor_action_grants = GrantCollection()

    database = GrantDatabase()
    monkeypatch.setattr(server, "base_db", database)
    worker = {
        "id": "worker-a",
        "is_worker": True,
        "_active_company_id": "superiqfoam",
        "_session_id": "session-a",
        "worker_allowed_sections": ["customers"],
        "worker_write_permissions": {
            "customers": {"create": "allow", "update": "supervisor", "delete": "deny"},
        },
    }
    req = request("/api/customers/customer-a", "unused", "PUT")
    req.scope["headers"] = [(b"x-supervisor-authorization", b"signed-grant")]
    grant = {
        "scope": "supervisor_worker_action",
        "sub": "worker-a",
        "company_id": "superiqfoam",
        "sid": "session-a",
        "action": "customers:update",
        "jti": "grant-a",
    }
    monkeypatch.setattr(server.jwt, "decode", lambda *args, **kwargs: grant)

    asyncio.run(server.require_supervisor_for_company_write(req, worker))

    assert database.supervisor_action_grants.query["action"] == "customers:update"
    assert database.supervisor_action_grants.query["company_id"] == "superiqfoam"


def test_warehouses_section_is_only_available_to_manufacturing_workers():
    server.validate_worker_company_sections("iqfoam-manufactoring", ["warehouses"])

    with pytest.raises(HTTPException) as other_company:
        server.validate_worker_company_sections("superiqfoam", ["warehouses"])
    assert other_company.value.status_code == 400


def test_supervisor_actions_are_bound_to_worker_sections():
    server.validate_worker_supervisor_sections(["invoices"], ["invoice_edit"])
    with pytest.raises(HTTPException) as missing_settings:
        server.validate_worker_supervisor_sections(["invoices"], ["price_edit"])
    assert missing_settings.value.status_code == 400


def test_only_designated_manufacturing_supervisors_can_edit_sensitive_records():
    non_supervisor = {
        "is_worker": True,
        "worker_is_supervisor": False,
        "worker_allowed_sections": ["invoices", "settings"],
    }
    with pytest.raises(HTTPException) as invoice_edit:
        server.enforce_worker_api_access(
            request("/api/invoices/invoice-1", "unused", "PUT"), non_supervisor,
        )
    assert invoice_edit.value.status_code == 403

    supervisor = {
        **non_supervisor,
        "worker_is_supervisor": True,
    }
    server.enforce_worker_api_access(
        request("/api/invoices/invoice-1", "unused", "PUT"), supervisor,
    )
    server.enforce_worker_api_access(
        request("/api/prices", "unused", "POST"), supervisor,
    )

    with pytest.raises(HTTPException) as missing_invoice_section:
        server.enforce_worker_api_access(
            request("/api/invoices/invoice-1", "unused", "PUT"),
            {**supervisor, "worker_allowed_sections": ["settings"]},
        )
    assert missing_invoice_section.value.status_code == 403


def test_supervisor_password_grant_is_scoped_to_action_and_company(monkeypatch):
    class GrantCollection:
        async def delete_one(self, query):
            self.query = query
            return type("DeleteResult", (), {"deleted_count": 1})()

    class GrantDatabase:
        def __init__(self):
            self.supervisor_action_grants = GrantCollection()

    grant = {
        "scope": "supervisor_worker_action",
        "sub": "worker-a",
        "company_id": "iqfoam-manufactoring",
        "sid": "session-a",
        "action": "invoice_edit",
        "jti": "grant-a",
    }
    database = GrantDatabase()
    monkeypatch.setattr(server, "base_db", database)
    worker = {
        "id": "worker-a",
        "is_worker": True,
        "worker_is_supervisor": True,
        "worker_supervisor_password_actions": ["invoice_edit"],
        "_active_company_id": "iqfoam-manufactoring",
        "_session_id": "session-a",
    }
    req = Request({
        "type": "http",
        "method": "PUT",
        "path": "/api/invoices/invoice-a",
        "raw_path": b"/api/invoices/invoice-a",
        "query_string": b"",
        "headers": [(b"x-supervisor-authorization", b"signed-grant")],
        "scheme": "https",
        "server": ("test", 443),
        "client": ("127.0.0.1", 1),
    })

    with pytest.raises(HTTPException) as missing_authorization:
        asyncio.run(server.require_supervisor_for_company_write(req, worker))
    assert missing_authorization.value.status_code == 428

    monkeypatch.setattr(server.jwt, "decode", lambda *args, **kwargs: grant)
    mismatched_action = {**grant, "action": "price_edit"}
    monkeypatch.setattr(server.jwt, "decode", lambda *args, **kwargs: mismatched_action)
    with pytest.raises(HTTPException) as wrong_action:
        asyncio.run(server.require_supervisor_for_company_write(req, worker))
    assert wrong_action.value.status_code == 428

    monkeypatch.setattr(server.jwt, "decode", lambda *args, **kwargs: grant)
    asyncio.run(server.require_supervisor_for_company_write(req, worker))

    assert database.supervisor_action_grants.query["scope"] == "supervisor_worker_action"
    assert database.supervisor_action_grants.query["action"] == "invoice_edit"
    assert database.supervisor_action_grants.query["company_id"] == "iqfoam-manufactoring"


@pytest.fixture
def worker_accounts(monkeypatch):
    workers = [
        {
            "id": "worker-a", "name": "Zeen", "username": "zeen",
            "password_hash": server.hash_pw("zeen-password"),
            "role": "user", "company_roles": {"superiqfoam": "user"},
            "company_ids": ["superiqfoam"], "is_worker": True,
            "worker_role": "Invoicing", "worker_allowed_sections": ["invoices"],
            "worker_stock_only": False, "active": True,
        },
        {
            "id": "worker-b", "name": "Other Worker", "username": "other",
            "password_hash": server.hash_pw("other-password"),
            "role": "user", "company_roles": {"iqfoam-whole-sallers": "user"},
            "company_ids": ["iqfoam-whole-sallers"], "is_worker": True,
            "worker_role": "Stock", "worker_allowed_sections": ["stock"],
            "worker_stock_only": False, "active": True,
        },
        {
            "id": "owner", "name": "Owner", "username": "owner",
            "role": "owner", "company_roles": {}, "active": True,
        },
    ]
    database = FakeDatabase(workers)
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "log_audit", _no_audit)
    return workers, database


async def _no_audit(*args, **kwargs):
    return None


def test_worker_link_auth_scope_dynamic_permissions_and_revocation(worker_accounts):
    _, database = worker_accounts
    owner = {"id": "owner", "role": "owner"}

    async def scenario():
        first = await server.issue_worker_personal_link("worker-a", "superiqfoam", owner)
        second = await server.issue_worker_personal_link("worker-b", "iqfoam-whole-sallers", owner)
        first_token = first["access_token"]
        second_token = second["access_token"]
        assert first_token != second_token
        stored_worker = next(item for item in database.users.documents if item["id"] == "worker-a")
        assert stored_worker["personal_access_token_hash"] == server.worker_access_token_hash(first_token)
        assert first_token not in stored_worker["personal_access_token_encrypted"]

        link_info = await server.worker_access_link_info(first_token, Response())
        assert link_info["company_id"] == "superiqfoam"
        assert set(link_info) == {"username", "company_id", "company_name"}
        assert "iqfoam-whole-sallers" not in repr(link_info)
        assert (await server.worker_access_link_info(second_token, Response()))["company_id"] == "iqfoam-whole-sallers"

        with pytest.raises(HTTPException) as other_worker:
            await server.login(server.LoginIn(
                username="other", password="other-password", company_id="superiqfoam",
                personal_access_token=first_token,
            ), Response())
        assert other_worker.value.status_code == 401

        login = await server.login(server.LoginIn(
            username="other", password="zeen-password", company_id="iqfoam-whole-sallers",
            personal_access_token=first_token,
            role="admin", allowed_sections=["expenses"],
        ), Response())
        assert login["user"]["id"] == "worker-a"
        assert login["user"]["company_id"] == "superiqfoam"
        assert login["user"]["role"] == "user"
        assert login["user"]["allowed_sections"] == ["invoices"]
        access_token = login["token"]

        invoice_user = await server.get_current_user(request("/api/invoices", access_token))
        assert invoice_user["worker_allowed_sections"] == ["invoices"]
        with pytest.raises(HTTPException) as denied_expenses:
            await server.get_current_user(request("/api/expenses", access_token))
        assert denied_expenses.value.status_code == 403
        assert (await server.get_current_user(
            request("/api/customers/customer-a/summary", access_token)
        ))["id"] == "worker-a"

        await database.users.update_one({"id": "worker-a"}, {"$set": {
            "worker_allowed_sections": ["expenses"],
        }})
        with pytest.raises(HTTPException) as denied_invoice:
            await server.get_current_user(request("/api/invoices", access_token))
        assert denied_invoice.value.status_code == 403
        assert (await server.get_current_user(request("/api/expenses", access_token)))["id"] == "worker-a"

        profiles = await server.company_profiles(request("/api/companies/profiles", access_token))
        assert [profile["id"] for profile in profiles] == ["superiqfoam"]

        for company_id in ("iqfoam-manufactoring", "iqfoam-whole-sallers"):
            with pytest.raises(HTTPException) as other_company:
                await server.authorize_company(invoice_user, company_id)
            assert other_company.value.status_code == 403
        with pytest.raises(HTTPException) as unprivileged_management:
            await server.get_worker_personal_link(
                "worker-a", "superiqfoam", Response(), invoice_user,
            )
        assert unprivileged_management.value.status_code == 403
        with pytest.raises(HTTPException) as unprivileged_company_change:
            await server.update_user_companies(
                "worker-a", server.UserCompaniesIn(company_ids=["iqfoam-whole-sallers"]), invoice_user,
            )
        assert unprivileged_company_change.value.status_code == 403
        with pytest.raises(HTTPException) as role_change:
            await server.update_user_role(
                "worker-a", server.UserRoleIn(role="admin", company_id="superiqfoam"), owner,
            )
        assert role_change.value.status_code == 400
        with pytest.raises(HTTPException) as company_change:
            await server.update_user_companies(
                "worker-a", server.UserCompaniesIn(company_ids=["superiqfoam", "iqfoam-whole-sallers"]), owner,
            )
        assert company_change.value.status_code == 400

        rotated = await server.issue_worker_personal_link(
            "worker-a", "superiqfoam", owner, regenerate=True,
        )
        assert rotated["access_token"] != first_token
        with pytest.raises(HTTPException) as old_link:
            await server.worker_access_link_info(first_token, Response())
        assert old_link.value.status_code == 404

        await server.revoke_worker_personal_link("worker-a", "superiqfoam", owner)
        with pytest.raises(HTTPException) as revoked_link:
            await server.worker_access_link_info(rotated["access_token"], Response())
        assert revoked_link.value.status_code == 404
        with pytest.raises(HTTPException) as revoked_session:
            await server.get_current_user(request("/api/invoices", access_token))
        assert revoked_session.value.status_code == 401
        await database.users.update_one({"id": "worker-a"}, {"$set": {"active": True}})
        with pytest.raises(HTTPException) as revoked_password_login:
            await server.login(server.LoginIn(
                username="zeen", password="zeen-password", company_id="superiqfoam",
            ), Response())
        assert revoked_password_login.value.status_code == 403

        reactivated = await server.issue_worker_personal_link("worker-a", "superiqfoam", owner)
        assert reactivated["active"] is True
        assert (        await server.worker_access_link_info(reactivated["access_token"], Response()))["username"] == "zeen"

    asyncio.run(scenario())


def test_company_owner_can_view_add_and_change_worker_roles(worker_accounts):
    _, database = worker_accounts
    database.user_sessions.documents.append({"id": "worker-session", "user_id": "worker-a"})
    admin = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "owner"},
    }

    async def scenario():
        workers = await server.get_workers("superiqfoam", admin)
        assert [worker["id"] for worker in workers] == ["worker-a"]

        created = await server.create_worker(server.CreateWorkerIn(
            username="new-worker",
            name="New Worker",
            worker_role="Packing",
            password="secure-pass-123",
            company_id="superiqfoam",
            allowed_sections=["invoices"],
            write_permissions={
                "invoices": {"create": "deny", "update": "supervisor", "delete": "deny"},
            },
        ), admin)
        assert created["worker_role"] == "Packing"
        assert created["company_id"] == "superiqfoam"
        assert created["write_permissions"]["invoices"]["update"] == "supervisor"
        stored = next(item for item in database.users.documents if item["id"] == created["id"])
        assert stored["worker_write_permissions"] == created["write_permissions"]

        updated = await server.update_worker_access(
            "worker-a",
            server.WorkerAccessUpdateIn(
                worker_role="Senior Invoicing",
                allowed_sections=["invoices", "stock"],
            ),
            "superiqfoam",
            admin,
        )
        assert updated["worker_role"] == "Senior Invoicing"
        assert updated["allowed_sections"] == ["invoices", "stock"]
        assert database.user_sessions.documents == []

        with pytest.raises(HTTPException) as other_company:
            await server.get_workers("iqfoam-whole-sallers", admin)
        assert other_company.value.status_code == 403

    asyncio.run(scenario())


@pytest.mark.parametrize("account", [
    {
        "id": "company-admin",
        "role": "user",
        "_active_role": "admin",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "admin"},
    },
    {
        "id": "worker-admin",
        "role": "user",
        "_active_role": "admin",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "admin"},
        "is_worker": True,
    },
    {
        "id": "ordinary-worker",
        "role": "user",
        "_active_role": "user",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "user"},
        "is_worker": True,
    },
])
def test_non_owners_cannot_view_or_manage_worker_accounts_or_links(worker_accounts, account):
    with pytest.raises(HTTPException) as list_error:
        asyncio.run(server.get_workers("superiqfoam", account))
    assert list_error.value.status_code == 403

    async def scenario():
        with pytest.raises(HTTPException) as link_error:
            await server.worker_access_details("worker-a", "superiqfoam", account)
        assert link_error.value.status_code == 403

        with pytest.raises(HTTPException) as create_error:
            await server.create_worker(server.CreateWorkerIn(
                username="forbidden-worker",
                name="Forbidden Worker",
                worker_role="Clerk",
                password="worker-password",
                company_id="superiqfoam",
                allowed_sections=["invoices"],
            ), account)
        assert create_error.value.status_code == 403

        with pytest.raises(HTTPException) as update_error:
            await server.update_worker_access(
                "worker-a",
                server.WorkerAccessUpdateIn(worker_role="Changed", allowed_sections=["stock"]),
                "superiqfoam",
                account,
            )
        assert update_error.value.status_code == 403

        with pytest.raises(HTTPException) as password_error:
            await server.update_worker_password(
                "worker-a", "superiqfoam",
                server.ProfilePasswordIn(password="new-secure-pass"),
                account,
            )
        assert password_error.value.status_code == 403

        with pytest.raises(HTTPException) as remove_error:
            await server.remove_worker("worker-a", "superiqfoam", account)
        assert remove_error.value.status_code == 403

    asyncio.run(scenario())


def test_manufacturing_worker_creation_saves_warehouse_and_supervisor_permissions(worker_accounts):
    _, database = worker_accounts
    admin = {
        "id": "manufacturing-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": "iqfoam-manufactoring",
        "company_roles": {"iqfoam-manufactoring": "owner"},
    }

    async def scenario():
        no_warehouse = await server.create_worker(server.CreateWorkerIn(
            username="no-warehouse-worker",
            name="No Warehouse Worker",
            worker_role="Invoice Clerk",
            password="secure-pass-123",
            company_id="iqfoam-manufactoring",
            allowed_sections=["invoices", "expenses"],
        ), admin)
        assert no_warehouse["warehouse_ids"] == []

        with pytest.raises(HTTPException) as without_section:
            await server.create_worker(server.CreateWorkerIn(
                username="bad-warehouse-worker",
                name="Bad Warehouse Worker",
                worker_role="Clerk",
                password="secure-pass-123",
                company_id="iqfoam-manufactoring",
                allowed_sections=["invoices"],
                warehouse_ids=["A"],
            ), admin)
        assert without_section.value.status_code == 400

        created = await server.create_worker(server.CreateWorkerIn(
            username="manufacturing-worker",
            name="Manufacturing Worker",
            worker_role="Invoice Clerk",
            password="secure-password",
            company_id="iqfoam-manufactoring",
            allowed_sections=["invoices", "settings", "warehouses"],
            is_supervisor=True,
            warehouse_ids=["B", "A"],
            supervisor_password_actions=["invoice_edit", "price_edit"],
        ), admin)
        assert created["warehouse_ids"] == ["A", "B"]
        assert created["is_supervisor"] is True
        assert created["supervisor_password_actions"] == ["invoice_edit", "price_edit"]

        stored = await database.users.find_one({"id": created["id"]})
        assert stored["worker_warehouse_ids"] == ["A", "B"]
        assert server.worker_warehouse_ids({"worker_warehouse_id": "C"}) == ["C"]
        server.require_warehouse_report_access({**stored, "_active_company_id": "iqfoam-manufactoring"}, "B")
        with pytest.raises(HTTPException):
            server.require_warehouse_report_access({**stored, "_active_company_id": "iqfoam-manufactoring"}, "C")
        assert stored["worker_supervisor_password_actions"] == ["invoice_edit", "price_edit"]

    asyncio.run(scenario())


def test_company_owner_can_reset_worker_password_only_in_their_company(worker_accounts):
    _, database = worker_accounts
    admin = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "owner"},
    }

    async def scenario():
        result = await server.update_worker_password(
            "worker-a", "superiqfoam",
            server.ProfilePasswordIn(password="new-secure-pass"),
            admin,
        )
        assert result == {"ok": True}
        worker = await database.users.find_one({"id": "worker-a"})
        assert server.verify_pw("new-secure-pass", worker["password_hash"])
        assert not server.verify_pw("zeen-password", worker["password_hash"])

        with pytest.raises(HTTPException) as wrong_company:
            await server.update_worker_password(
                "worker-a", "iqfoam-whole-sallers",
                server.ProfilePasswordIn(password="new-secure-pass"),
                admin,
            )
        assert wrong_company.value.status_code == 403

        with pytest.raises(HTTPException) as weak_password:
            await server.update_worker_password(
                "worker-a", "superiqfoam",
                server.ProfilePasswordIn(password="short"),
                admin,
            )
        assert weak_password.value.status_code == 400

    asyncio.run(scenario())


@pytest.mark.parametrize("method,path,action", [
    ("PUT", "/api/invoices/abc", "invoice_edit"),
    ("DELETE", "/api/prices/abc", "price_delete"),
    ("DELETE", "/api/customers/abc", "customer_delete"),
    ("DELETE", "/api/stock/abc", "stock_delete"),
    ("DELETE", "/api/payments/abc/other-balance", "balance_payment_delete"),
    ("POST", "/api/invoices/abc/void", None),
    ("POST", "/api/payments/abc/reverse", None),
    ("POST", "/api/invoices/abc/payments", None),
    ("GET", "/api/invoices/abc", None),
])
def test_worker_supervisor_action_routes(method, path, action):
    assert server.worker_supervisor_action(path, method) == action
