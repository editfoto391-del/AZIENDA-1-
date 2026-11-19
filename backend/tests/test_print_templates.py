import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server


class MemoryCollection:
    def __init__(self):
        self.documents = {}

    async def find_one(self, query, projection=None):
        return deepcopy(self.documents.get(query.get("id")))

    async def update_one(self, query, update, upsert=False):
        record_id = query.get("id")
        document = deepcopy(self.documents.get(record_id) or {})
        document.update(deepcopy(update.get("$set", {})))
        self.documents[record_id] = document


def install_print_templates(monkeypatch):
    collection = MemoryCollection()
    monkeypatch.setattr(server, "base_db", SimpleNamespace(print_templates=collection))

    async def no_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "log_audit", no_audit)
    return collection


def test_company_users_can_read_only_the_active_company_template(monkeypatch):
    collection = install_print_templates(monkeypatch)
    collection.documents["superiqfoam"] = {
        "id": "superiqfoam",
        "name": "Approved invoice",
        "print_trigger": "on_issue",
    }
    company_user = {"_active_company_id": "superiqfoam", "role": "user"}

    template = asyncio.run(server.get_print_template(company_user))

    assert template["name"] == "Approved invoice"
    assert template["company_id"] == "superiqfoam"
    assert template["print_trigger"] == "on_issue"
    with pytest.raises(HTTPException) as denied:
        asyncio.run(server.get_print_template(company_user, "imraan-plastics"))
    assert denied.value.status_code == 403


def test_only_global_owner_can_save_templates_for_any_company(monkeypatch):
    collection = install_print_templates(monkeypatch)
    monkeypatch.setenv("ADMIN_EMAIL", "global-owner@example.test")
    owner = {
        "role": "owner",
        "email": "global-owner@example.test",
        "is_worker": False,
        "_active_company_id": "superiqfoam",
    }
    template = server.PrintTemplateUpdate(name="Central invoice", header_text="Company header")

    saved = asyncio.run(server.update_print_template(template, owner, "imraan-plastics"))

    assert saved["company_id"] == "imraan-plastics"
    assert collection.documents["imraan-plastics"]["header_text"] == "Company header"
    assert collection.documents["imraan-plastics"]["updated_by"] == owner["email"]

    company_owner = {**owner, "email": "profile-owner@example.test"}
    with pytest.raises(HTTPException) as denied:
        asyncio.run(server.update_print_template(template, company_owner, "superiqfoam"))
    assert denied.value.status_code == 403


@pytest.mark.parametrize("values", [
    {"primary_color": "red"},
    {"font_size": 30},
    {"margin_mm": 1},
    {"columns": ["quantity", "total"]},
    {"logo_data_url": "data:text/html;base64,PHNjcmlwdD4="},
])
def test_template_validation_rejects_unsafe_or_invalid_values(values):
    with pytest.raises(ValidationError):
        server.PrintTemplateUpdate(**values)


def test_template_defaults_leave_printing_manual_and_preserve_invoice_layout():
    template = server.default_print_template("superiqfoam")

    assert template["print_trigger"] == "manual"
    assert template["is_configured"] is False
    assert template["columns"] == []
    assert template["company_id"] == "superiqfoam"


@pytest.mark.parametrize("section", ["invoices", "express-invoices", "orders", "deliveries"])
def test_invoice_workers_can_read_approved_templates(section):
    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/print-templates"),
        method="GET",
    )
    worker = {
        "is_worker": True,
        "worker_allowed_sections": [section],
        "_active_role": "user",
    }

    server.enforce_worker_api_access(request, worker)
