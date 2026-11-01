import asyncio
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

import server
from workflow_engine import (
    ACTION_DEFINITIONS,
    TRIGGER_DEFINITIONS,
    WorkflowValidationError,
    evaluate_conditions,
    event_payload,
    render_action_template,
    validate_event_payload,
    validate_workflow_definition,
)


class Cursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, *_args):
        return self

    def skip(self, count):
        self.documents = self.documents[count:]
        return self

    def limit(self, count):
        self.documents = self.documents[:count]
        return self

    async def to_list(self, length=None):
        return deepcopy(self.documents[:length])


class Collection:
    def __init__(self, documents=(), fail_inserts=False):
        self.documents = [deepcopy(document) for document in documents]
        self.fail_inserts = fail_inserts
        self.indexes = []

    def find(self, query=None, _projection=None):
        query = query or {}
        return Cursor([
            document for document in self.documents
            if all(document.get(key) == value for key, value in query.items())
        ])

    async def find_one(self, query, _projection=None):
        return deepcopy(next((
            document for document in self.documents
            if all(document.get(key) == value for key, value in query.items())
        ), None))

    async def insert_one(self, document):
        if self.fail_inserts:
            raise RuntimeError("controlled output write failure")
        if self is not None and "workflow_id" in document and "event_id" in document:
            unique_key = (
                document.get("company_id"), document.get("workflow_id"), document.get("event_id"),
            )
            if any(
                (item.get("company_id"), item.get("workflow_id"), item.get("event_id")) == unique_key
                for item in self.documents
            ):
                raise DuplicateKeyError("duplicate workflow event")
        self.documents.append(deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, **_kwargs):
        document = next((
            item for item in self.documents
            if all(item.get(key) == value for key, value in query.items())
        ), None)
        if not document:
            return SimpleNamespace(matched_count=0)
        document.update(deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1)

    async def update_many(self, query, update):
        count = 0
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                document.update(deepcopy(update.get("$set", {})))
                count += 1
        return SimpleNamespace(matched_count=count)

    async def find_one_and_update(self, query, update, **_kwargs):
        document = next((
            item for item in self.documents
            if all(item.get(key) == value for key, value in query.items())
        ), None)
        if not document:
            return None
        document.update(deepcopy(update.get("$set", {})))
        return deepcopy(document)

    async def delete_one(self, query):
        document = next((
            item for item in self.documents
            if all(item.get(key) == value for key, value in query.items())
        ), None)
        if document:
            self.documents.remove(document)
        return SimpleNamespace(deleted_count=1 if document else 0)

    async def count_documents(self, query):
        return len([
            document for document in self.documents
            if all(document.get(key) == value for key, value in query.items())
        ])

    async def create_index(self, keys, **options):
        self.indexes.append((keys, options))


class Database:
    def __init__(self, **collections):
        self.collections = collections

    def __getattr__(self, name):
        return self.collections[name]


class FailsOnSecondArtifact(Collection):
    async def insert_one(self, document):
        if document["type"] == "add_internal_flag":
            raise RuntimeError("controlled second-action failure")
        return await super().insert_one(document)


def valid_workflow(**changes):
    workflow = {
        "name": "Payment follow-up",
        "trigger": "payment.recorded",
        "logic": "all",
        "conditions": [{"field": "amount", "operator": "greater_than", "value": 500}],
        "actions": [{
            "type": "create_follow_up_task",
            "title": "Check payment",
            "message": "Review this payment with the finance team.",
        }],
        "enabled": True,
    }
    return {**workflow, **changes}


def test_global_owner_identity_is_role_and_primary_account(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "primary@example.test")
    owner = {"id": "owner", "email": "primary@example.test", "role": "owner"}
    assert server.is_global_owner_account(owner)
    server.require_global_owner(owner)

    denied_users = [
        {"email": "primary@example.test", "role": "user"},
        {"email": "company-owner@example.test", "role": "user", "company_roles": {"superiqfoam": "owner"}},
        {"email": "admin@example.test", "role": "user", "company_roles": {"superiqfoam": "admin"}},
        {"email": "supervisor@example.test", "role": "user"},
        {"email": "other-owner@example.test", "role": "owner"},
        {"email": "primary@example.test", "role": "owner", "is_worker": True},
    ]
    for user in denied_users:
        with pytest.raises(HTTPException) as error:
            server.require_global_owner(user)
        assert error.value.status_code == 403


def test_workflow_api_and_direct_route_deny_non_global_users(monkeypatch):
    monkeypatch.setenv("ADMIN_EMAIL", "primary@example.test")
    non_owner = {"id": "company-admin", "email": "admin@example.test", "role": "user"}
    async def authenticated_non_owner(_request):
        return non_owner

    monkeypatch.setattr(server, "get_current_user", authenticated_non_owner)

    async def request_routes():
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            responses = [
                await client.get("/api/workflow-builder/catalog"),
                await client.get("/api/workflow-builder?company_id=superiqfoam"),
                await client.post("/api/workflow-builder", json={"untrusted": True}),
                await client.put("/api/workflow-builder/wf-1", json={"untrusted": True}),
                await client.post("/api/workflow-builder/wf-1/duplicate?company_id=superiqfoam"),
                await client.post("/api/workflow-builder/wf-1/status?company_id=superiqfoam", json={}),
                await client.post("/api/workflow-builder/wf-1/test?company_id=superiqfoam", json={}),
                await client.delete("/api/workflow-builder/wf-1?company_id=superiqfoam"),
                await client.get("/api/workflow-builder/runs?company_id=superiqfoam"),
                await client.get("/api/workflow-builder/outputs?company_id=superiqfoam"),
                await client.post("/api/workflow-builder/outputs/out-1/decision?company_id=superiqfoam", json={}),
            ]
        return responses

    responses = asyncio.run(request_routes())
    assert [response.status_code for response in responses] == [403] * 11


def test_supported_events_and_safe_typed_condition_evaluation():
    assert len(TRIGGER_DEFINITIONS) == 50
    assert {
        "invoice.issued", "invoice.voided", "payment.reversed", "buying.created",
        "supplier.deactivated", "purchase_order.received", "grv.confirmed",
        "production.daily_saved", "piece_production.saved", "vehicle_record.cancelled",
        "spare_part.restored", "delivery.dispatched",
    }.issubset(TRIGGER_DEFINITIONS)
    assert not any("schedule" in trigger for trigger in TRIGGER_DEFINITIONS)
    payload = event_payload("payment.recorded", {
        "amount": 650.0, "method": "EFT", "date": "2026-10-31", "invoice_number": "INV-1",
        "customer_email": "not copied",
    })
    assert payload == {
        "amount": 650.0, "method": "EFT", "date": "2026-10-31", "invoice_number": "INV-1",
    }
    assert event_payload("purchase_order.created", {"amount": 780, "supplier_name": "Foam Supply"}) == {
        "total": 780, "supplier_name": "Foam Supply",
    }
    definition = validate_workflow_definition(valid_workflow(logic="any", conditions=[
        {"field": "amount", "operator": "greater_than", "value": 700},
        {"field": "method", "operator": "equals", "value": "EFT"},
    ]))
    matched, evaluated = evaluate_conditions(
        definition["trigger"], definition["conditions"], definition["logic"], payload,
    )
    assert matched is True
    assert [item["matched"] for item in evaluated] == [False, True]


@pytest.mark.parametrize("bad_condition", [
    {"field": "amount", "operator": "contains", "value": "5"},
    {"field": "customer.email", "operator": "equals", "value": "x"},
    {"field": "amount", "operator": "greater_than", "value": True},
    {"field": "amount", "operator": "greater_than", "value": float("inf")},
    {"field": "amount", "operator": "greater_than", "value": 2, "expression": "x"},
])
def test_condition_validation_rejects_bad_types_fields_and_expressions(bad_condition):
    with pytest.raises(WorkflowValidationError):
        validate_workflow_definition(valid_workflow(conditions=[bad_condition]))


def test_action_validation_rejects_code_urls_and_unapproved_operations():
    for action in (
        {"type": "run_python", "message": "print(1)"},
        {"type": "create_notification", "message": "https://example.test", "url": "https://example.test"},
        {"type": "create_notification", "message": "safe", "javascript": "alert(1)"},
    ):
        with pytest.raises(WorkflowValidationError):
            validate_workflow_definition(valid_workflow(actions=[action]))
    assert len(ACTION_DEFINITIONS) == 7


def test_action_templates_allow_only_current_trigger_fields_and_render_safely():
    template = valid_workflow(actions=[{
        "type": "create_notification",
        "title": "Payment {{invoice_number}}",
        "message": "R {{amount}} via {{method}}",
    }])
    validate_workflow_definition(template)
    assert render_action_template(template["actions"][0]["message"], {
        "amount": 800, "method": "EFT",
    }) == "R 800 via EFT"
    with pytest.raises(WorkflowValidationError):
        validate_workflow_definition(valid_workflow(actions=[{
            "type": "create_notification",
            "message": "Payment {{company_id}}",
        }]))


def test_dry_run_records_history_without_creating_erp_or_workflow_outputs(monkeypatch):
    workflow = {
        **valid_workflow(),
        "id": "workflow-1",
        "company_id": "superiqfoam",
    }
    database = Database(
        companies=Collection([
            {"id": "superiqfoam", "active": True},
            {"id": "iqfoam-manufactoring", "active": True},
        ]),
        workflows=Collection([workflow]),
        workflow_runs=Collection(),
        workflow_artifacts=Collection(),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    monkeypatch.setenv("ADMIN_EMAIL", "primary@example.test")
    owner = {"id": "owner", "email": "primary@example.test", "role": "owner"}

    result = asyncio.run(server.dry_run_workflow(
        "workflow-1",
        server.WorkflowDryRunIn(event_data={"amount": 650, "method": "EFT"}),
        "superiqfoam",
        owner,
    ))
    assert result["dry_run"] is True and result["matched"] is True
    assert len(database.workflow_runs.documents) == 1
    assert database.workflow_runs.documents[0]["dry_run"] is True
    assert database.workflow_artifacts.documents == []
    assert set(database.collections) == {
        "companies", "workflows", "workflow_runs", "workflow_artifacts",
    }


def test_global_owner_can_manage_scoped_workflows_and_review_approval(monkeypatch):
    database = Database(
        companies=Collection([
            {"id": "superiqfoam", "active": True},
            {"id": "iqfoam-manufactoring", "active": True},
        ]),
        workflows=Collection(),
        workflow_runs=Collection(),
        workflow_artifacts=Collection([{
            "id": "approval-1",
            "company_id": "superiqfoam",
            "type": "request_global_owner_approval",
            "status": "pending",
        }]),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    monkeypatch.setenv("ADMIN_EMAIL", "primary@example.test")
    owner = {"id": "owner", "email": "primary@example.test", "role": "owner"}
    body = server.WorkflowDefinitionIn(
        company_id="superiqfoam",
        **valid_workflow(enabled=False),
    )

    created = asyncio.run(server.create_workflow(body, owner))
    assert created["company_id"] == "superiqfoam" and created["enabled"] is False
    copied = asyncio.run(server.duplicate_workflow(created["id"], "superiqfoam", owner))
    assert copied["enabled"] is False and copied["id"] != created["id"]
    enabled = asyncio.run(server.set_workflow_status(
        created["id"], server.WorkflowToggleIn(enabled=True), "superiqfoam", owner,
    ))
    assert enabled["enabled"] is True
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.edit_workflow(
            created["id"],
            server.WorkflowDefinitionIn(
                company_id="iqfoam-manufactoring",
                **valid_workflow(),
            ),
            owner,
        ))
    assert error.value.status_code == 404

    decision = asyncio.run(server.decide_workflow_approval(
        "approval-1",
        server.WorkflowApprovalDecisionIn(decision="approved", note="Reviewed"),
        "superiqfoam",
        owner,
    ))
    assert decision["status"] == "approved"
    asyncio.run(server.delete_workflow(created["id"], "superiqfoam", owner))
    assert len(database.workflow_runs.documents) == 0


def test_disabled_workflows_are_never_executed(monkeypatch):
    disabled = {**valid_workflow(), "id": "disabled", "company_id": "superiqfoam", "enabled": False}
    database = Database(
        workflows=Collection([disabled]),
        workflow_runs=Collection(),
        workflow_artifacts=Collection(),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    token = server.active_company_id.set("superiqfoam")
    try:
        asyncio.run(server.emit_workflow_event("payment.recorded", {
            "id": "payment-1", "created_at": "2026-10-31T12:00:00+00:00", "amount": 650,
        }))
    finally:
        server.active_company_id.reset(token)
    assert database.workflow_runs.documents == []
    assert database.workflow_artifacts.documents == []


def test_event_execution_is_company_scoped_deduplicated_and_keeps_history(monkeypatch):
    workflow_a = {**valid_workflow(), "id": "wf-a", "company_id": "superiqfoam"}
    workflow_b = {**valid_workflow(), "id": "wf-b", "company_id": "iqfoam-manufactoring"}
    database = Database(
        workflows=Collection([workflow_a, workflow_b]),
        workflow_runs=Collection(),
        workflow_artifacts=Collection(),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    token = server.active_company_id.set("superiqfoam")
    record = {
        "id": "payment-1", "created_at": "2026-10-31T12:00:00+00:00",
        "amount": 650, "method": "EFT",
    }
    try:
        asyncio.run(server.emit_workflow_event("payment.recorded", record))
        asyncio.run(server.emit_workflow_event("payment.recorded", record))
    finally:
        server.active_company_id.reset(token)

    assert len(database.workflow_runs.documents) == 1
    assert database.workflow_runs.documents[0]["result"] == "success"
    assert database.workflow_runs.documents[0]["company_id"] == "superiqfoam"
    assert len(database.workflow_artifacts.documents) == 1
    assert database.workflow_artifacts.documents[0]["company_id"] == "superiqfoam"


def test_action_failures_are_recorded_without_raising_or_modifying_business_data(monkeypatch):
    workflow = {**valid_workflow(), "id": "wf-fail", "company_id": "superiqfoam"}
    database = Database(
        workflows=Collection([workflow]),
        workflow_runs=Collection(),
        workflow_artifacts=Collection(fail_inserts=True),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    token = server.active_company_id.set("superiqfoam")
    try:
        asyncio.run(server.emit_workflow_event("payment.recorded", {
            "id": "payment-failure", "created_at": "2026-10-31T12:00:00+00:00", "amount": 650,
        }))
    finally:
        server.active_company_id.reset(token)
    run = database.workflow_runs.documents[0]
    assert run["result"] == "failed"
    assert run["actions_attempted"][0]["status"] == "failed"
    assert run["error_details"]
    assert database.workflow_artifacts.documents == []


def test_partial_action_execution_is_recorded(monkeypatch):
    workflow = {
        **valid_workflow(),
        "id": "wf-partial",
        "company_id": "superiqfoam",
        "actions": [
            {"type": "create_notification", "title": "", "message": "First action."},
            {"type": "add_internal_flag", "title": "", "message": "Second action."},
        ],
    }
    database = Database(
        workflows=Collection([workflow]),
        workflow_runs=Collection(),
        workflow_artifacts=FailsOnSecondArtifact(),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    token = server.active_company_id.set("superiqfoam")
    try:
        asyncio.run(server.emit_workflow_event("payment.recorded", {
            "id": "payment-partial", "created_at": "2026-10-31T12:00:00+00:00", "amount": 650,
        }))
    finally:
        server.active_company_id.reset(token)
    run = database.workflow_runs.documents[0]
    assert run["result"] == "partial"
    assert [action["status"] for action in run["actions_attempted"]] == ["completed", "failed"]
    assert len(database.workflow_artifacts.documents) == 1


def test_dry_run_payload_rejects_unsupported_fields_and_invalid_values():
    with pytest.raises(WorkflowValidationError):
        validate_event_payload("payment.recorded", {"amount": 100, "python": "pass"})
    with pytest.raises(WorkflowValidationError):
        validate_event_payload("payment.recorded", {"amount": float("nan")})


def test_workflow_indexes_provide_deduplication_pagination_and_no_ttl(monkeypatch):
    database = Database(
        workflows=Collection(),
        workflow_runs=Collection(),
        workflow_artifacts=Collection(),
    )
    monkeypatch.setattr(server, "base_db", database)
    monkeypatch.setattr(server, "_workflow_database", lambda _company_id: database)
    asyncio.run(server.initialize_workflow_indexes())

    run_indexes = database.workflow_runs.indexes
    assert any(options.get("unique") for _keys, options in run_indexes)
    all_indexes = [
        index for collection in database.collections.values() for index in collection.indexes
    ]
    assert all("expireAfterSeconds" not in options for _keys, options in all_indexes)
