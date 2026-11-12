import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import server


class MemoryCursor:
    def __init__(self, documents):
        self.documents = documents

    async def to_list(self, length):
        return self.documents[:length]


class MemorySessions:
    def __init__(self, sessions):
        self.sessions = sessions

    def find(self, query, projection):
        return MemoryCursor(self.sessions)


def test_access_users_returns_latest_login_for_each_company_profile(monkeypatch):
    now = datetime.now(timezone.utc)
    def timestamp(minutes_ago):
        return (now - timedelta(minutes=minutes_ago)).isoformat()

    accounts = [
        {
            "id": "wholesale-admin",
            "username": "wholesale-admin",
            "role": "user",
            "company_roles": {server.WHOLESALERS_COMPANY_ID: "admin"},
        },
        {
            "id": "company-owner",
            "username": "company-owner",
            "role": "user",
            "company_roles": {server.DEFAULT_COMPANY_ID: "owner"},
        },
        {
            "id": "warehouse-worker",
            "username": "warehouse-worker",
            "role": "user",
            "is_worker": True,
            "company_roles": {server.MANUFACTURING_COMPANY_ID: "user"},
        },
    ]
    sessions = [
        {"user_id": "wholesale-admin", "company_id": server.DEFAULT_COMPANY_ID,
         "last_seen": timestamp(20), "expires_at": (now + timedelta(hours=1)).isoformat()},
        {"user_id": "wholesale-admin", "company_id": server.WHOLESALERS_COMPANY_ID,
         "last_seen": timestamp(2), "expires_at": (now + timedelta(hours=1)).isoformat()},
        {"user_id": "company-owner", "company_id": server.DEFAULT_COMPANY_ID,
         "last_seen": timestamp(4), "expires_at": (now + timedelta(hours=1)).isoformat()},
        {"user_id": "warehouse-worker", "company_id": server.MANUFACTURING_COMPANY_ID,
         "last_seen": timestamp(8), "expires_at": (now + timedelta(hours=1)).isoformat()},
    ]

    async def listall(collection, **kwargs):
        return accounts if collection == "users" else []

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(
        server,
        "base_db",
        SimpleNamespace(user_sessions=MemorySessions(sessions)),
    )
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")

    result = asyncio.run(server.access_users({"role": "owner"}))
    users = {account["id"]: account for account in result}

    assert users["wholesale-admin"]["last_access_by_company"] == {
        server.DEFAULT_COMPANY_ID: timestamp(20),
        server.WHOLESALERS_COMPANY_ID: timestamp(2),
    }
    assert users["wholesale-admin"]["last_login"] == timestamp(2)
    assert users["company-owner"]["last_access_by_company"] == {
        server.DEFAULT_COMPANY_ID: timestamp(4),
    }
    assert users["warehouse-worker"]["last_access_by_company"] == {
        server.MANUFACTURING_COMPANY_ID: timestamp(8),
    }


def test_access_users_merges_duplicate_profile_accounts_without_merging_workers(monkeypatch):
    now = datetime.now(timezone.utc)
    newer = (now - timedelta(minutes=3)).isoformat()
    older = (now - timedelta(days=2)).isoformat()
    company_id = server.MANUFACTURING_COMPANY_ID
    accounts = [
        {
            "id": "profile-admin-new",
            "username": "IQFOAM MANUFACTORING",
            "name": "IQFOAM MANUFACTORING",
            "role": "user",
            "profile_id": company_id,
            "profile_login": "admin",
            "company_roles": {company_id: "admin"},
        },
        {
            "id": "profile-admin-legacy",
            "username": "IQFOAM MANUFACTURING",
            "name": "IQFOAM MANUFACTURING",
            "role": "user",
            "profile_id": company_id,
            "company_roles": {company_id: "admin"},
        },
        {
            "id": "worker",
            "username": "warehouse-worker",
            "role": "user",
            "is_worker": True,
            "company_roles": {company_id: "user"},
        },
    ]
    sessions = [
        {"user_id": "profile-admin-new", "company_id": company_id,
         "last_seen": newer, "expires_at": (now + timedelta(hours=1)).isoformat()},
        {"user_id": "profile-admin-legacy", "company_id": server.DEFAULT_COMPANY_ID,
         "last_seen": older, "expires_at": (now + timedelta(hours=1)).isoformat()},
    ]

    async def listall(collection, **kwargs):
        return accounts if collection == "users" else []

    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(
        server,
        "base_db",
        SimpleNamespace(user_sessions=MemorySessions(sessions)),
    )
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")

    result = asyncio.run(server.access_users({"role": "owner"}))
    profile_rows = [account for account in result if account.get("is_profile_account")]
    workers = [account for account in result if account.get("is_worker")]

    assert len(result) == 2
    assert len(profile_rows) == 1
    assert profile_rows[0]["id"] == f"profile-account:{company_id}"
    assert profile_rows[0]["company_roles"] == {company_id: "admin"}
    assert profile_rows[0]["last_access_by_company"] == {
        company_id: newer,
        server.DEFAULT_COMPANY_ID: older,
    }
    assert len(workers) == 1
