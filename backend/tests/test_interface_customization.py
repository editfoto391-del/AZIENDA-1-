import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


class MemoryCollection:
    def __init__(self):
        self.document = None

    async def find_one(self, query, projection=None):
        if self.document and self.document.get("id") == query.get("id"):
            return deepcopy(self.document)
        return None

    async def update_one(self, query, update, upsert=False):
        if self.document is None and not upsert:
            return
        self.document = deepcopy(self.document or {})
        self.document.update(deepcopy(update.get("$set", {})))


def _install_interface_settings(monkeypatch):
    collection = MemoryCollection()
    monkeypatch.setattr(server, "base_db", SimpleNamespace(interface_settings=collection))

    async def no_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "log_audit", no_audit)
    return collection


def test_interface_settings_default_to_the_original_menu():
    config = server.normalize_interface_config({})

    assert config["hidden_sections"] == []
    assert config["group_order"][0] == "overview"
    assert config["section_order"]["sales"] == [
        "customers", "orders", "invoices", "client-payments",
    ]


def test_only_global_owner_can_save_sitewide_interface_settings(monkeypatch):
    _install_interface_settings(monkeypatch)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    company_owner = {
        "role": "owner",
        "_active_role": "owner",
        "email": "company-owner@example.test",
    }

    with pytest.raises(HTTPException) as denied:
        asyncio.run(server.update_interface_settings(
            {"hidden_sections": ["grv"]}, company_owner,
        ))

    assert denied.value.status_code == 403


def test_global_owner_can_persist_menu_labels_visibility_and_order(monkeypatch):
    _install_interface_settings(monkeypatch)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    global_owner = {
        "role": "owner",
        "email": "global-owner@example.test",
        "is_worker": False,
    }
    body = {
        "hidden_sections": ["grv"],
        "section_labels": {"client-payments": "Customer balances"},
        "group_labels": {"sales": "Commercial"},
        "group_order": ["sales", "overview"],
        "section_order": {"sales": ["invoices", "customers"]},
    }

    saved = asyncio.run(server.update_interface_settings(body, global_owner))
    loaded = asyncio.run(server.get_interface_settings(global_owner))

    assert loaded == saved
    assert loaded["hidden_sections"] == ["grv"]
    assert loaded["section_labels"] == {"client-payments": "Customer balances"}
    assert loaded["group_labels"] == {"sales": "Commercial"}
    assert loaded["group_order"][:2] == ["sales", "overview"]
    assert loaded["section_order"]["sales"] == [
        "invoices", "customers", "orders", "client-payments",
    ]


@pytest.mark.parametrize("body", [
    {"hidden_sections": ["not-a-real-section"]},
    {"group_order": ["not-a-real-group"]},
    {"section_order": {"sales": ["grv"]}},
    {"section_labels": {"grv": "x" * 49}},
])
def test_interface_settings_reject_unknown_or_invalid_menu_changes(body):
    with pytest.raises(HTTPException) as invalid:
        server.normalize_interface_config(body)

    assert invalid.value.status_code == 422
