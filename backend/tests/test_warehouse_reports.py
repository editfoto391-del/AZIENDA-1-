import asyncio
from copy import deepcopy
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server


class WarehouseReportCollection:
    def __init__(self):
        self.documents = []

    async def insert_one(self, document):
        self.documents.append(deepcopy(document))

    async def find_one(self, query, projection=None):
        return next(
            (
                deepcopy(document)
                for document in self.documents
                if all(document.get(key) == value for key, value in query.items())
            ),
            None,
        )

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if all(document.get(key) == value for key, value in query.items()):
                self.documents.pop(index)
                return type("DeleteResult", (), {"deleted_count": 1})()
        return type("DeleteResult", (), {"deleted_count": 0})()

    def find(self, query, projection=None):
        return WarehouseReportCursor(self.documents, query)


class WarehouseReportCursor:
    def __init__(self, documents, query):
        self.documents = [deepcopy(doc) for doc in documents if doc.get("warehouse_id") == query["warehouse_id"]]

    def sort(self, key, direction):
        self.documents.sort(key=lambda doc: doc.get(key, ""), reverse=direction < 0)
        return self

    async def to_list(self, limit):
        return deepcopy(self.documents[:limit])


class WarehouseReportDatabase:
    def __init__(self):
        self.warehouse_reports = WarehouseReportCollection()
        self.warehouse_report_share_links = WarehouseReportCollection()

    def __getitem__(self, collection):
        return getattr(self, collection)


def report_payload():
    return server.WarehouseReportIn(
        date="2026-11-02",
        chemicals=[{"chemical": "Polyol", "quantity": 12.5, "unit": "L"}],
        manufactured_blocks=[{"block_type": "White", "size": "2m x 1m", "quantity": 8}],
        foam_cut=[{"size": "50mm", "quantity": 4.5, "unit": "m³"}],
        damaged_blocks=[{"block_type": "White", "size": "2m x 1m", "quantity": 1}],
        sheets_cut=[{"size": "1000 x 2000mm", "quantity": 12}],
        notes="Shift report",
    )


def warehouse_b_report_payload():
    return server.WarehouseBReportIn(
        date="2026-11-02",
        foam_received=[{"quantity": 120, "unit": "m3"}],
        mattresses_received=[
            {"size": "Single", "quantity": 18},
            {"size": "Double", "quantity": 12},
        ],
        mattresses_completed=[
            {"size": "Single", "quantity": 15},
            {"size": "Double", "quantity": 10},
        ],
        notes="Receiving and bundling shift",
    )


def warehouse_c_report_payload():
    return server.WarehouseCReportIn(
        date="2026-11-02",
        completed_stock=[
            {"size": "Single", "quantity": 24},
            {"size": "Double", "quantity": 16},
        ],
        dispatches=[
            {
                "customer_name": "Customer One",
                "invoice_number": "INV-1042",
                "size": "Single",
                "ordered_quantity": 6,
                "loaded_quantity": 6,
            },
            {
                "customer_name": "Customer One",
                "invoice_number": "INV-1042",
                "size": "Double",
                "ordered_quantity": 4,
                "loaded_quantity": 3,
            },
        ],
    )


def test_warehouse_report_requires_a_valid_date_and_at_least_one_activity():
    with pytest.raises(ValidationError):
        server.WarehouseReportIn(date="2026-02-30", chemicals=[{
            "chemical": "Polyol", "quantity": 1, "unit": "L",
        }])

    with pytest.raises(ValidationError):
        server.WarehouseReportIn(date="2026-11-02")


def test_warehouse_b_report_requires_valid_data_and_integer_mattress_counts():
    with pytest.raises(ValidationError):
        server.WarehouseBReportIn(date="2026-11-02")

    with pytest.raises(ValidationError):
        server.WarehouseBReportIn(
            date="2026-11-02",
            mattresses_received=[{"size": "Single", "quantity": 1.5}],
        )


def test_warehouse_c_report_checks_dispatch_quantities():
    report = warehouse_c_report_payload()
    assert sum(line.loaded_quantity for line in report.dispatches) == 9

    with pytest.raises(ValidationError):
        server.WarehouseCReportIn(
            date="2026-11-02",
            dispatches=[{
                "customer_name": "Customer One",
                "invoice_number": "INV-1042",
                "size": "Single",
                "ordered_quantity": 5,
                "loaded_quantity": 6,
            }],
        )


def test_warehouse_block_counts_must_be_whole_numbers():
    with pytest.raises(ValidationError):
        server.WarehouseReportIn(
            date="2026-11-02",
            manufactured_blocks=[{
                "block_type": "White", "size": "2m x 1m", "quantity": 1.5,
            }],
        )


def test_warehouse_report_access_is_limited_to_assigned_manufacturing_workers():
    worker = {
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "A",
    }
    server.require_warehouse_report_access(worker, "A")

    with pytest.raises(HTTPException) as wrong_warehouse:
        server.require_warehouse_report_access({**worker, "worker_warehouse_id": "B"}, "A")
    assert wrong_warehouse.value.status_code == 403

    with pytest.raises(HTTPException) as missing_section:
        server.require_warehouse_report_access({**worker, "worker_allowed_sections": []}, "A")
    assert missing_section.value.status_code == 403

    with pytest.raises(HTTPException) as wrong_company:
        server.require_warehouse_report_access({**worker, "_active_company_id": "superiqfoam"}, "A")
    assert wrong_company.value.status_code == 403


def test_warehouse_report_endpoints_are_available_to_workers_with_warehouse_access():
    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/warehouses/A/reports"),
        method="POST",
    )
    worker = {"is_worker": True, "worker_allowed_sections": ["warehouses"]}
    server.enforce_worker_api_access(request, worker)

    with pytest.raises(HTTPException) as missing_access:
        server.enforce_worker_api_access(request, {
            "is_worker": True,
            "worker_allowed_sections": [],
        })
    assert missing_access.value.status_code == 403
    share_request = SimpleNamespace(
        url=SimpleNamespace(path="/api/warehouses/B/reports/report-1/share-link"),
        method="POST",
    )
    server.enforce_worker_api_access(request=share_request, user={
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
    })


def test_warehouse_a_report_saves_and_loads_with_audit(monkeypatch):
    database = WarehouseReportDatabase()
    audit_entries = []

    async def log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", log_audit)
    user = {
        "id": "worker-a",
        "name": "Warehouse Worker",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "A",
    }

    async def scenario():
        saved = await server.save_warehouse_a_report(report_payload(), user)
        reports = await server.get_warehouse_a_reports(user)
        return saved, reports

    saved, reports = asyncio.run(scenario())

    assert saved["warehouse_id"] == "A"
    assert saved["created_by"] == "worker-a"
    assert saved["created_by_name"] == "Warehouse Worker"
    assert saved["manufactured_blocks"][0]["quantity"] == 8
    assert [report["id"] for report in reports] == [saved["id"]]
    assert audit_entries[0][0][:3] == ("warehouse_report", saved["id"], "created")


def test_warehouse_a_report_can_be_deleted_with_audit_and_is_scoped_to_warehouse_a(monkeypatch):
    database = WarehouseReportDatabase()
    audit_entries = []

    async def log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", log_audit)
    user = {
        "id": "worker-a",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "A",
    }
    owner = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": False,
    }

    async def scenario():
        report = await server.save_warehouse_a_report(report_payload(), user)
        with pytest.raises(HTTPException) as worker_delete:
            await server.delete_warehouse_a_report(report["id"], user)
        deleted = await server.delete_warehouse_a_report(report["id"], owner)
        remaining = await server.get_warehouse_a_reports(user)
        return report, worker_delete.value, deleted, remaining

    report, worker_delete, deleted, remaining = asyncio.run(scenario())

    assert worker_delete.status_code == 403
    assert deleted == {"ok": True, "deleted": True}
    assert remaining == []
    assert audit_entries[-1][0][:3] == (
        "warehouse_report", report["id"], "permanently_deleted",
    )
    assert audit_entries[-1][1]["before"]["warehouse_id"] == "A"

    with pytest.raises(HTTPException) as missing_report:
        asyncio.run(server.delete_warehouse_a_report("missing-report", owner))
    assert missing_report.value.status_code == 404


def test_warehouse_report_delete_cannot_remove_reports_from_another_warehouse(monkeypatch):
    database = WarehouseReportDatabase()
    database.warehouse_reports.documents.append({
        "id": "warehouse-b-report",
        "warehouse_id": "B",
    })
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    user = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": False,
    }

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.delete_warehouse_a_report("warehouse-b-report", user))

    assert error.value.status_code == 404
    assert database.warehouse_reports.documents == [{"id": "warehouse-b-report", "warehouse_id": "B"}]


def test_warehouse_b_report_saves_loads_and_deletes_for_owner(monkeypatch):
    database = WarehouseReportDatabase()
    audit_entries = []

    async def log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", log_audit)
    worker_b = {
        "id": "worker-b",
        "name": "Warehouse B Worker",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "B",
    }
    worker_a = {**worker_b, "worker_warehouse_id": "A"}
    owner = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": False,
    }

    async def scenario():
        report = await server.save_warehouse_b_report(warehouse_b_report_payload(), worker_b)
        reports = await server.get_warehouse_b_reports(worker_b)
        with pytest.raises(HTTPException) as wrong_worker:
            await server.get_warehouse_b_reports(worker_a)
        with pytest.raises(HTTPException) as worker_delete:
            await server.delete_warehouse_b_report(report["id"], worker_b)
        deleted = await server.delete_warehouse_b_report(report["id"], owner)
        return report, reports, wrong_worker.value, worker_delete.value, deleted

    report, reports, wrong_worker, worker_delete, deleted = asyncio.run(scenario())

    assert report["warehouse_id"] == "B"
    assert report["foam_received"][0] == {"quantity": 120, "unit": "m3"}
    assert report["mattresses_received"][1] == {"size": "Double", "quantity": 12}
    assert report["mattresses_completed"][0] == {"size": "Single", "quantity": 15}
    assert [item["id"] for item in reports] == [report["id"]]
    assert wrong_worker.status_code == 403
    assert worker_delete.status_code == 403
    assert deleted == {"ok": True, "deleted": True}
    assert audit_entries[-1][0][:3] == (
        "warehouse_report", report["id"], "permanently_deleted",
    )


def test_warehouse_c_report_calculates_dispatch_total_and_owner_can_delete(monkeypatch):
    database = WarehouseReportDatabase()
    audit_entries = []

    async def log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", log_audit)
    worker_c = {
        "id": "worker-c",
        "name": "Warehouse C Worker",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "C",
    }
    worker_a = {**worker_c, "worker_warehouse_id": "A"}
    owner = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": False,
    }

    async def scenario():
        report = await server.save_warehouse_c_report(warehouse_c_report_payload(), worker_c)
        reports = await server.get_warehouse_c_reports(worker_c)
        with pytest.raises(HTTPException) as wrong_worker:
            await server.get_warehouse_c_reports(worker_a)
        with pytest.raises(HTTPException) as worker_delete:
            await server.delete_warehouse_c_report(report["id"], worker_c)
        deleted = await server.delete_warehouse_c_report(report["id"], owner)
        return report, reports, wrong_worker.value, worker_delete.value, deleted

    report, reports, wrong_worker, worker_delete, deleted = asyncio.run(scenario())

    assert report["warehouse_id"] == "C"
    assert report["completed_stock"][0] == {"size": "Single", "quantity": 24}
    assert report["dispatches"][0]["customer_name"] == "Customer One"
    assert report["dispatches"][0]["invoice_number"] == "INV-1042"
    assert report["total_quantity_loaded"] == 9
    assert [item["id"] for item in reports] == [report["id"]]
    assert wrong_worker.status_code == 403
    assert worker_delete.status_code == 403
    assert deleted == {"ok": True, "deleted": True}
    assert audit_entries[-1][0][:3] == (
        "warehouse_report", report["id"], "permanently_deleted",
    )


def test_warehouse_report_share_link_is_stable_and_public_report_is_minimal(monkeypatch):
    database = WarehouseReportDatabase()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: database)
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    user = {
        "id": "worker-b",
        "name": "Warehouse B Worker",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": True,
        "worker_allowed_sections": ["warehouses"],
        "worker_warehouse_id": "B",
    }

    async def scenario():
        report = await server.save_warehouse_b_report(warehouse_b_report_payload(), user)
        first_response = server.Response()
        first = await server.create_warehouse_report_share_link(
            "B", report["id"], first_response, user,
        )
        second = await server.create_warehouse_report_share_link(
            "B", report["id"], server.Response(), user,
        )
        public_response = server.Response()
        shared = await server.get_public_warehouse_report_share(
            first["token"], public_response,
        )
        return report, first, second, first_response, public_response, shared

    report, first, second, first_response, public_response, shared = asyncio.run(scenario())

    assert first["token"] == second["token"]
    assert first_response.headers["Cache-Control"] == "no-store"
    assert public_response.headers["X-Robots-Tag"] == "noindex, nofollow"
    assert shared["report"]["warehouse_id"] == "B"
    assert shared["report"]["foam_received"] == [{"quantity": 120, "unit": "m3"}]
    assert "created_by" not in shared["report"]
    assert "company_id" not in shared["report"]
    assert len(database.warehouse_report_share_links.documents) == 1
    assert database.warehouse_report_share_links.documents[0]["warehouse_report_id"] == report["id"]

    with pytest.raises(HTTPException) as malformed:
        asyncio.run(server.get_public_warehouse_report_share("invalid", server.Response()))
    assert malformed.value.status_code == 404


def test_deleting_a_warehouse_report_revokes_its_public_share_link(monkeypatch):
    database = WarehouseReportDatabase()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "tenant_database", lambda *_args: database)
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    owner = {
        "id": "company-owner",
        "role": "user",
        "_active_role": "owner",
        "_active_company_id": server.MANUFACTURING_COMPANY_ID,
        "is_worker": False,
    }

    async def scenario():
        report = await server.save_warehouse_c_report(warehouse_c_report_payload(), owner)
        share_link = await server.issue_warehouse_report_share_link("C", report["id"], owner)
        await server.delete_warehouse_c_report(report["id"], owner)
        return share_link

    token = asyncio.run(scenario())
    with pytest.raises(HTTPException) as revoked:
        asyncio.run(server.get_public_warehouse_report_share(token, server.Response()))
    assert revoked.value.status_code == 404
