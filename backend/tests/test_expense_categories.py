import asyncio

import pytest
from fastapi import HTTPException

import server


def test_global_owner_can_create_expense_without_supervisor_password(monkeypatch):
    created = []

    async def insert(collection, document):
        record = {**document, "id": "expense-1"}
        created.append(record)
        return record

    async def no_audit(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "insert", insert)
    monkeypatch.setattr(server, "log_audit", no_audit)
    global_owner = {
        "id": "global-owner",
        "email": "owner@example.test",
        "role": "owner",
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }

    expense = asyncio.run(server.add_expense(
        server.ExpenseIn(description="Test expense", amount=125),
        global_owner,
    ))
    assert expense["supervisor_approved_by"] == "global-owner"
    assert expense["amount"] == 125
    assert created == [expense]


def test_supervisor_exempt_authorizations_keep_required_audit_identity():
    global_owner = {
        "id": "global-owner",
        "email": "owner@example.test",
        "role": "owner",
        "_active_company_id": server.DEFAULT_COMPANY_ID,
    }

    async def verify():
        authorizations = await asyncio.gather(
            server.consume_invoice_action_authorization(
                None, "invoice-1", "void", global_owner,
            ),
            server.consume_expense_authorization(
                None, "expense-1", "void", global_owner,
            ),
            server.consume_monthly_purchase_authorization(
                None, "purchase-1", "edit", global_owner,
            ),
            server.consume_fleet_expense_authorization(
                None, "vehicle_record", "create", global_owner,
            ),
        )
        assert all(item["supervisor_id"] == global_owner["id"] for item in authorizations)

    asyncio.run(verify())


@pytest.mark.parametrize("category", [
    "Bilal", "Yassine", "Bilal and Yassine", "Personal Car", "Home",
])
def test_superiqfoam_personal_expense_categories(category):
    expense = server.ExpenseIn(description="Personal expense", amount=100, category=category)
    server._check_expense(expense, {"_active_company_id": server.DEFAULT_COMPANY_ID})


@pytest.mark.parametrize("category", [
    "Bilal", "Yassine", "Bilal and Yassine", "Personal Car", "Home",
])
def test_personal_expense_categories_are_not_available_outside_superiqfoam(category):
    expense = server.ExpenseIn(
        description="Personal expense",
        amount=100,
        category=category,
    )
    with pytest.raises(HTTPException) as error:
        server._check_expense(expense, {"_active_company_id": "iqfoam-manufactoring"})
    assert error.value.status_code == 400


def test_expense_model_no_longer_accepts_expense_for_field():
    expense = server.ExpenseIn(
        description="Personal expense",
        amount=100,
        expense_for="Bilal",
    )
    assert "expense_for" not in expense.model_dump()
