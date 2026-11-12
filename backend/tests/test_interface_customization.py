import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


class MemoryCollection:
    def __init__(self):
        self.documents = {}

    async def find_one(self, query, projection=None):
        return deepcopy(self.documents.get(query.get("id")))

    async def update_one(self, query, update, upsert=False):
        record_id = query.get("id")
        if record_id not in self.documents and not upsert:
            return
        document = deepcopy(self.documents.get(record_id) or {})
        document.update(deepcopy(update.get("$set", {})))
        self.documents[record_id] = document


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


def test_interface_settings_reads_ignore_legacy_document_fields(monkeypatch):
    collection = _install_interface_settings(monkeypatch)
    collection.documents["superiqfoam"] = {
        "id": "superiqfoam",
        "section_labels": {"customers": "Clients"},
        "legacy_customization": {"old_field": True},
    }

    config = asyncio.run(server.get_interface_settings({
        "_active_company_id": "superiqfoam",
    }))

    assert config["section_labels"] == {"customers": "Clients"}
    assert "legacy_customization" not in config


def test_interface_settings_writes_still_reject_unsupported_fields(monkeypatch):
    _install_interface_settings(monkeypatch)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    owner = {
        "role": "owner",
        "email": "global-owner@example.test",
        "is_worker": False,
    }

    with pytest.raises(HTTPException) as invalid:
        asyncio.run(server.update_interface_settings(
            {"legacy_customization": {"old_field": True}},
            owner,
        ))

    assert invalid.value.status_code == 422


def test_global_owner_saves_independent_interface_settings_per_company(monkeypatch):
    collection = _install_interface_settings(monkeypatch)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    owner = {
        "role": "owner",
        "email": "global-owner@example.test",
        "_active_company_id": "superiqfoam",
        "is_worker": False,
    }

    asyncio.run(server.update_interface_settings(
        {"group_labels": {"sales": "Sales at SuperIQ"}}, owner,
    ))
    asyncio.run(server.update_interface_settings(
        {"group_labels": {"sales": "Sales at Manufacturing"}},
        owner,
        company_id="iqfoam-manufactoring",
    ))

    superiq = asyncio.run(server.get_interface_settings(owner, company_id="superiqfoam"))
    manufacturing = asyncio.run(server.get_interface_settings(
        owner, company_id="iqfoam-manufactoring",
    ))

    assert superiq["group_labels"]["sales"] == "Sales at SuperIQ"
    assert manufacturing["group_labels"]["sales"] == "Sales at Manufacturing"
    assert set(collection.documents) == {"superiqfoam", "iqfoam-manufactoring"}


def test_company_user_cannot_read_another_profiles_interface_settings(monkeypatch):
    _install_interface_settings(monkeypatch)
    user = {
        "role": "user",
        "_active_role": "user",
        "_active_company_id": "iqfoam-manufactoring",
        "email": "company-user@example.test",
    }

    with pytest.raises(HTTPException) as denied:
        asyncio.run(server.get_interface_settings(
            user, company_id="superiqfoam",
        ))

    assert denied.value.status_code == 403


def test_custom_menu_sections_link_only_to_existing_pages():
    config = server.normalize_interface_config({
        "custom_sections": [{
            "id": "finance-shortcut",
            "label": "Fast expenses",
            "path": "/expenses",
        }],
    })

    assert config["custom_sections"] == [{
        "id": "finance-shortcut",
        "label": "Fast expenses",
        "path": "/expenses",
        "access_section": "expenses",
    }]


def test_custom_menu_destinations_are_limited_to_the_selected_company_profile():
    section = {
        "id": "production-shortcut",
        "label": "Production",
        "path": "/production",
    }

    with pytest.raises(HTTPException) as invalid:
        server.normalize_interface_config(
            {"custom_sections": [section]},
            company_id=server.WHOLESALERS_COMPANY_ID,
        )

    assert invalid.value.status_code == 422
    config = server.normalize_interface_config(
        {"custom_sections": [section]},
        company_id=server.DEFAULT_COMPANY_ID,
    )
    assert config["custom_sections"][0]["path"] == "/production"


@pytest.mark.parametrize("body", [
    {"hidden_sections": ["not-a-real-section"]},
    {"group_order": ["not-a-real-group"]},
    {"section_order": {"sales": ["grv"]}},
    {"section_labels": {"grv": "x" * 49}},
    {"custom_sections": [{"id": "bad-link", "label": "Bad", "path": "https://example.com"}]},
    {"custom_sections": [{"id": "bad-access", "label": "Bad", "path": "/expenses", "access_section": "settings"}]},
])
def test_interface_settings_reject_unknown_or_invalid_menu_changes(body):
    with pytest.raises(HTTPException) as invalid:
        server.normalize_interface_config(body)

    assert invalid.value.status_code == 422
