import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


def test_dismiss_all_notifications_requires_global_owner(monkeypatch):
    async def unexpected_update_many(*_args, **_kwargs):
        raise AssertionError("Notifications must not be changed for a non-global owner")

    def deny_global_owner(_user):
        raise HTTPException(403, "Global Owner access required")

    monkeypatch.setattr(server, "require_global_owner", deny_global_owner)
    monkeypatch.setattr(
        server,
        "base_db",
        SimpleNamespace(notifications=SimpleNamespace(update_many=unexpected_update_many)),
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.dismiss_all_notifications({"id": "admin-user"}))

    assert error.value.status_code == 403


def test_dismiss_all_notifications_only_affects_current_owner_and_company(monkeypatch):
    calls = {}

    async def update_many(query, update):
        calls["query"] = query
        calls["update"] = update
        return SimpleNamespace(modified_count=4)

    monkeypatch.setattr(server, "require_global_owner", lambda _user: None)
    monkeypatch.setattr(
        server,
        "base_db",
        SimpleNamespace(notifications=SimpleNamespace(update_many=update_many)),
    )
    token = server.active_company_id.set("company-1")
    try:
        result = asyncio.run(server.dismiss_all_notifications({"id": "owner-user"}))
    finally:
        server.active_company_id.reset(token)

    assert result == {"ok": True, "dismissed_count": 4}
    assert calls["query"] == {
        "company_id": "company-1",
        "recipient_user_id": "owner-user",
        "archived": {"$ne": True},
        "permanently_dismissed": {"$ne": True},
    }
    assert calls["update"]["$set"]["permanently_dismissed"] is True
    assert calls["update"]["$set"]["read"] is True
