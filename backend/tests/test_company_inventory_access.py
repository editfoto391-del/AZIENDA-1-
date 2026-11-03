from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


def test_company_inventory_worker_access_is_read_only_for_stock_workers():
    worker = {"is_worker": True, "worker_allowed_sections": ["stock"]}

    server.require_company_inventory_access(worker, read_only=True)

    with pytest.raises(HTTPException) as error:
        server.require_company_inventory_access(worker)
    assert error.value.status_code == 403

    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/company-inventory"),
        method="GET",
    )
    server.enforce_worker_api_access(request, worker)

    request.method = "POST"
    with pytest.raises(HTTPException) as error:
        server.enforce_worker_api_access(request, worker)
    assert error.value.status_code == 403


def test_company_inventory_is_not_visible_to_workers_without_stock_access():
    worker = {"is_worker": True, "worker_allowed_sections": ["invoices"]}

    with pytest.raises(HTTPException) as error:
        server.require_company_inventory_access(worker, read_only=True)
    assert error.value.status_code == 403


def test_company_inventory_is_available_to_company_users():
    server.require_company_inventory_access({"is_worker": False})
