import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import server


class Collection:
    def __init__(self, documents=()):
        self.documents = [deepcopy(document) for document in documents]

    async def find_one(self, query, projection=None):
        for document in self.documents:
            if self._matches(document, query):
                return deepcopy(document)
        return None

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def update_one(self, query, update, upsert=False):
        document = next(
            (item for item in self.documents if self._matches(item, query)),
            None,
        )
        if document is None:
            return SimpleNamespace(matched_count=0)
        for key, value in update.get("$set", {}).items():
            document[key] = deepcopy(value)
        for key, value in update.get("$inc", {}).items():
            document[key] = document.get(key, 0) + value
        return SimpleNamespace(matched_count=1)

    async def delete_one(self, query):
        document = next((item for item in self.documents if self._matches(item, query)), None)
        if not document:
            return SimpleNamespace(deleted_count=0)
        self.documents.remove(document)
        return SimpleNamespace(deleted_count=1)

    async def delete_many(self, query):
        matched = [item for item in self.documents if self._matches(item, query)]
        for item in matched:
            self.documents.remove(item)
        return SimpleNamespace(deleted_count=len(matched))

    @staticmethod
    def _matches(document, query):
        for key, expected in query.items():
            value = document
            for part in key.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if isinstance(expected, dict):
                if "$lt" in expected and not value < expected["$lt"]:
                    return False
                if "$ne" in expected and value == expected["$ne"]:
                    return False
                if "$in" in expected and value not in expected["$in"]:
                    return False
                if "$gt" in expected and not value > expected["$gt"]:
                    return False
            elif value != expected:
                return False
        return True


class Database:
    def __init__(self, **collections):
        self.collections = collections

    def __getattr__(self, name):
        return self.collections[name]


def test_company_owner_can_switch_only_to_an_assigned_company(monkeypatch):
    user = {
        "id": "company-owner",
        "role": "user",
        "company_roles": {"company-a": "owner", "company-b": "admin"},
        "_session_id": "session-1",
    }
    monkeypatch.setattr(server, "base_db", Database(user_sessions=Collection([{"id": "session-1"}])))
    monkeypatch.setattr(server, "make_token", lambda *args: "new-token")
    monkeypatch.setenv("ADMIN_EMAIL", "primary-owner@example.com")
    public = server.public_user({
        **user,
        "_active_company_id": "company-a",
    })
    assert public["can_switch_company"] is True
    assert public["company_ids"] == [profile["id"] for profile in server.COMPANY_PROFILES]
    company_admin = {
        "id": "company-admin",
        "role": "user",
        "company_roles": {
            server.WHOLESALERS_COMPANY_ID: "admin",
            "company-b": "user",
        },
        "_session_id": "admin-session",
    }
    company_admin_public = server.public_user({
        **company_admin,
        "_active_company_id": server.WHOLESALERS_COMPANY_ID,
        "_active_role": "admin",
    })
    assert company_admin_public["can_switch_company"] is True
    assert server.allowed_company_ids(company_admin) == [
        profile["id"] for profile in server.COMPANY_PROFILES
    ]
    assert company_admin_public["admin_company_ids"] == [
        profile["id"] for profile in server.COMPANY_PROFILES
    ]
    monkeypatch.setattr(server, "public_user", lambda selected: {"company_id": selected["_active_company_id"]})

    async def authorize(user, company_id, session_id):
        role = server.company_role(user, company_id)
        if role not in ("owner", "admin", "user"):
            raise HTTPException(403, "You are not assigned to this company")
        return {**user, "_active_company_id": company_id, "_active_role": role}

    monkeypatch.setattr(server, "authorize_company", authorize)

    async def verify():
        result = await server.switch_company(server.SwitchCompanyIn(company_id="company-b"), user)
        assert result == {"token": "new-token", "user": {"company_id": "company-b"}}
        result = await server.switch_company(server.SwitchCompanyIn(company_id="company-c"), user)
        assert result == {"token": "new-token", "user": {"company_id": "company-c"}}
        assert server.company_role(user, "company-c") == "owner"
        regular_user = {
            "id": "regular-user",
            "role": "user",
            "company_roles": {"company-a": "admin"},
        }
        with pytest.raises(HTTPException) as error:
            await server.switch_company(server.SwitchCompanyIn(company_id="company-b"), regular_user)
        assert error.value.status_code == 403
        result = await server.switch_company(server.SwitchCompanyIn(company_id="iqfoam-manufactoring"), company_admin)
        assert result == {"token": "new-token", "user": {"company_id": "iqfoam-manufactoring"}}
        assert server.company_role(company_admin, "iqfoam-manufactoring") == "admin"

    asyncio.run(verify())


def test_superiqfoam_company_owner_write_requires_one_time_supervisor_grant(monkeypatch):
    grants = Collection()
    monkeypatch.setattr(server, "base_db", Database(supervisor_action_grants=grants))
    monkeypatch.setenv("ADMIN_EMAIL", "primary-owner@example.com")
    user = {
        "id": "company-owner",
        "role": "user",
        "company_roles": {"iqfoam-whole-sallers": "owner"},
        "_active_company_id": "superiqfoam",
        "_session_id": "session-1",
    }
    wholesaler_admin_in_manufacturing = {
        "id": "company-admin",
        "role": "user",
        "company_roles": {server.WHOLESALERS_COMPANY_ID: "admin"},
        "_active_company_id": "iqfoam-manufactoring",
        "_session_id": "admin-session",
    }
    assert server.can_skip_supervisor_approval(wholesaler_admin_in_manufacturing)
    assert server.public_user(wholesaler_admin_in_manufacturing)["can_skip_supervisor_approval"] is True
    assert not server.can_skip_supervisor_approval({
        **wholesaler_admin_in_manufacturing,
        "_active_company_id": "superiqfoam",
    })
    assert not server.can_skip_supervisor_approval({
        "id": "other-admin",
        "role": "user",
        "company_roles": {"iqfoam-manufactoring": "admin"},
        "_active_company_id": "iqfoam-manufactoring",
    })
    def make_request(headers=(), path="/api/stock/stock-1"):
        return Request({
            "type": "http",
            "http_version": "1.1",
            "method": "PUT",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": list(headers),
            "client": ("127.0.0.1", 1234),
            "server": ("test", 443),
        })

    async def verify():
        with pytest.raises(HTTPException) as error:
            await server.require_supervisor_for_company_write(make_request(), user)
        assert error.value.status_code == 428

        company_admin = {
            "id": "company-admin",
            "role": "user",
            "company_roles": {"iqfoam-whole-sallers": "admin"},
            "_active_company_id": "superiqfoam",
            "_session_id": "admin-session",
        }
        with pytest.raises(HTTPException) as error:
            await server.require_supervisor_for_company_write(make_request(), company_admin)
        assert error.value.status_code == 428
        manufacturing_admin = {
            **company_admin,
            "_active_company_id": "iqfoam-manufactoring",
        }
        await server.require_supervisor_for_company_write(
            make_request(path="/api/stock/stock-1"),
            manufacturing_admin,
        )

        assert server.is_supervisor_password_endpoint("/api/auth/switch-company")
        await server.require_supervisor_for_company_write(
            Request({
                "type": "http",
                "http_version": "1.1",
                "method": "POST",
                "scheme": "https",
                "path": "/api/auth/switch-company",
                "raw_path": b"/api/auth/switch-company",
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 1234),
                "server": ("test", 443),
            }),
            user,
        )

        grant_id = "single-use-grant"
        expires_at = server.datetime.now(server.timezone.utc) + server.timedelta(minutes=1)
        grants.documents.append({
            "id": grant_id,
            "user_id": user["id"],
            "company_id": "superiqfoam",
            "session_id": user["_session_id"],
            "expires_at": expires_at,
        })
        authorization = server.jwt.encode({
            "sub": user["id"],
            "company_id": "superiqfoam",
            "sid": user["_session_id"],
            "scope": "supervisor_company_write",
            "jti": grant_id,
            "exp": expires_at,
        }, server.JWT_SECRET, algorithm=server.JWT_ALGO).encode()
        authorized_request = make_request([(b"x-supervisor-authorization", authorization)])
        await server.require_supervisor_for_company_write(authorized_request, user)
        with pytest.raises(HTTPException) as error:
            await server.require_supervisor_for_company_write(authorized_request, user)
        assert error.value.status_code == 428

    asyncio.run(verify())


def test_profile_admin_password_creates_a_real_admin_login(monkeypatch):
    users = Collection()
    admin_counts = Collection([{"_id": "iqfoam-whole-sallers", "count": 0}])
    monkeypatch.setattr(server, "base_db", Database(users=users, company_admin_counts=admin_counts))

    async def audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "log_audit", audit)
    owner = {"id": "global-owner", "role": "owner"}

    async def verify():
        result = await server.update_profile_password(
            "iqfoam-whole-sallers",
            "admin",
            server.ProfilePasswordIn(password="secure-test-password"),
            owner,
        )
        assert result == {
            "profile_id": "iqfoam-whole-sallers",
            "account_type": "admin",
            "configured": True,
        }
        account = users.documents[0]
        assert account["profile_login"] == "admin"
        assert account["company_roles"] == {"iqfoam-whole-sallers": "admin"}
        assert server.verify_pw("secure-test-password", account["password_hash"])
        assert admin_counts.documents[0]["count"] == 1

    asyncio.run(verify())
