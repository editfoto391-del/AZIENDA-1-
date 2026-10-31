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


def request(path, token):
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 443),
    })


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


def test_company_admin_can_view_add_and_change_worker_roles(worker_accounts):
    _, database = worker_accounts
    admin = {
        "id": "company-admin",
        "role": "user",
        "_active_role": "admin",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "admin"},
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
        ), admin)
        assert created["worker_role"] == "Packing"
        assert created["company_id"] == "superiqfoam"

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

        with pytest.raises(HTTPException) as other_company:
            await server.get_workers("iqfoam-whole-sallers", admin)
        assert other_company.value.status_code == 403

    asyncio.run(scenario())


def test_company_admin_can_reset_worker_password_only_in_their_company(worker_accounts):
    _, database = worker_accounts
    admin = {
        "id": "company-admin",
        "role": "user",
        "_active_role": "admin",
        "_active_company_id": "superiqfoam",
        "company_roles": {"superiqfoam": "admin"},
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
