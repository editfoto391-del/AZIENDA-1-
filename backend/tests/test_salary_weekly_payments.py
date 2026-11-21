import server
import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


def example_weekly_employees():
    return [
        {"employee_id": "worker-a", "name": "Worker A", "pay_frequency": "weekly_fixed", "net_salary": 2000},
        {"employee_id": "worker-b", "name": "Worker B", "pay_frequency": "weekly_fixed", "net_salary": 1800},
        {"employee_id": "worker-c", "name": "Worker C", "pay_frequency": "piece", "net_salary": 2500},
        {"employee_id": "worker-d", "name": "Worker D", "pay_frequency": "weekly_fixed", "net_salary": 1700},
        {"employee_id": "worker-e", "name": "Worker E", "pay_frequency": "weekly_fixed", "net_salary": 2000},
        {"employee_id": "monthly-worker", "name": "Monthly Worker", "pay_frequency": "monthly_fixed", "net_salary": 9000},
    ]


def test_weekly_salary_summary_splits_example_amounts_and_defaults_unselected_to_saturday():
    result = server.weekly_salary_payment_summary(
        example_weekly_employees(),
        ["worker-a", "worker-b", "worker-c"],
        [],
        [],
        "2026-11-16",
        "2026-11-21",
    )

    assert result["friday_date"] == "2026-11-20"
    assert result["saturday_date"] == "2026-11-21"
    assert result["friday"]["employee_count"] == 3
    assert result["friday"]["due_cents"] == 630000
    assert result["friday"]["cash_required_cents"] == 630000
    assert result["saturday"]["employee_count"] == 2
    assert result["saturday"]["due_cents"] == 370000
    assert result["saturday"]["cash_required_cents"] == 370000
    assert result["total_salaries_cents"] == 1000000
    assert result["total_paid_cents"] == 0
    assert result["outstanding_cents"] == 1000000
    assert [row["employee_id"] for row in result["saturday"]["employees"]] == [
        "worker-d", "worker-e",
    ]


def test_weekly_salary_summary_calculates_partial_payment_and_outstanding_cents():
    result = server.weekly_salary_payment_summary(
        example_weekly_employees()[:5],
        ["worker-a", "worker-b", "worker-c"],
        [{
            "employee_id": "worker-a",
            "payment_group": "friday",
            "paid_amount_cents": 125000,
            "payments": [{
                "id": "partial-a1", "amount_cents": 125000,
                "payment_date": "2026-11-20", "idempotency_key": "worker-a-payment-01",
            }],
        }, {
            "employee_id": "worker-b",
            "payment_group": "friday",
            "paid_amount_cents": 180000,
            "payments": [{
                "id": "full-b", "amount_cents": 180000,
                "payment_date": "2026-11-20", "idempotency_key": "worker-b-payment-01",
            }],
        }],
        [],
        "2026-11-16",
        "2026-11-21",
    )

    friday_rows = {row["employee_id"]: row for row in result["friday"]["employees"]}
    assert friday_rows["worker-a"]["due_cents"] == 200000
    assert friday_rows["worker-a"]["paid_cents"] == 125000
    assert friday_rows["worker-a"]["remaining_cents"] == 75000
    assert friday_rows["worker-a"]["payment_status"] == "Partially Paid"
    assert friday_rows["worker-b"]["remaining_cents"] == 0
    assert friday_rows["worker-b"]["payment_status"] == "Paid"
    assert result["friday"]["actually_paid_cents"] == 305000
    assert result["saturday"]["actually_paid_cents"] == 0
    assert result["total_paid_cents"] == 305000
    assert result["outstanding_cents"] == 695000


def test_weekly_salary_summary_exposes_fixed_salary_balance_cuts_and_net_pay():
    employee = {
        "employee_id": "worker-a",
        "name": "Worker A",
        "department": "Plastic",
        "pay_frequency": "weekly_fixed",
        "weekly_salary": 1000,
        "overtime_hours": 3,
        "overtime_rate": 15,
        "balance_before_period": 250,
        "balance_after_period": 150,
        "balance": 150,
        "balance_history": [],
        "gross_salary": 900,
        "cut": 100,
        "net_salary": 800,
    }

    result = server.weekly_salary_payment_summary(
        [employee], [], [], [], "2026-11-16", "2026-11-21",
    )
    row = result["saturday"]["employees"][0]

    assert row["weekly_salary"] == 1000
    assert row["overtime_hours"] == 3
    assert row["overtime_rate"] == 15
    assert row["balance_before_period"] == 250
    assert row["balance_cut"] == 100
    assert row["balance_after_period"] == 150
    assert row["gross_salary"] == 900
    assert row["net_salary"] == 800
    assert row["due_cents"] == 80000


def test_weekly_overtime_override_saves_values_without_replacing_attendance(monkeypatch):
    existing = {
        "status": "Present",
        "start_time": "08:00",
        "end_time": "17:00",
        "overtime_hours": 1,
        "notes": "Existing attendance note",
    }

    async def find_employee(_query, _projection=None):
        return {"id": "worker-a", "name": "Worker A", "department": "Plastic"}

    async def no_payment(*_args, **_kwargs):
        return None

    async def find_attendance(*_args, **_kwargs):
        return existing

    async def save_day(_collection, _employee_id, _date, data):
        assert data["status"] == "Present"
        assert data["start_time"] == "08:00"
        assert data["end_time"] == "17:00"
        assert data["overtime_hours"] == 1
        assert data["salary_overtime_override"] == 4
        assert data["salary_overtime_rate_override"] == 15
        return existing, {**existing, **data}

    async def no_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    monkeypatch.setattr(server, "_save_employee_day_record", save_day)
    monkeypatch.setattr(server, "log_audit", no_audit)
    monkeypatch.setattr(
        server,
        "db",
        SimpleNamespace(
            employees=SimpleNamespace(find_one=find_employee),
            salary_weekly_payment_accounts=SimpleNamespace(find_one=no_payment),
            salary_payments=SimpleNamespace(find_one=no_payment),
            attendance=SimpleNamespace(find_one=find_attendance),
        ),
    )

    result = asyncio.run(server.save_weekly_salary_overtime(
        server.WeeklyOvertimeIn(
            employee_id="worker-a",
            period_start="2026-11-16",
            period_end="2026-11-21",
            overtime_hours=4,
            overtime_rate=15,
        ),
        user={"role": "admin"},
    ))

    assert result == {"ok": True, "overtime_hours": 4}


def test_weekly_salary_summary_includes_legacy_full_payments_without_double_counting():
    result = server.weekly_salary_payment_summary(
        example_weekly_employees()[:5],
        ["worker-a"],
        [{
            "employee_id": "worker-a",
            "payment_group": "friday",
            "paid_amount_cents": 50000,
            "payments": [{
                "id": "should-not-double-count",
                "amount_cents": 50000,
                "payment_date": "2026-11-20",
            }],
        }],
        [{
            "id": "legacy-a",
            "employee_id": "worker-a",
            "net_amount": 2000,
            "payment_date": "2026-11-20",
        }],
        "2026-11-16",
        "2026-11-21",
    )

    worker_a = next(row for row in result["friday"]["employees"] if row["employee_id"] == "worker-a")
    assert worker_a["paid_cents"] == 200000
    assert worker_a["payment_status"] == "Paid"
    assert result["total_paid_cents"] == 200000


class Accounts:
    def __init__(self):
        self.records = {}

    async def find_one(self, query, _projection=None):
        record = self.records.get(query["id"])
        return deepcopy(record) if record else None

    async def update_one(self, query, update, upsert=False):
        record = self.records.get(query["id"])
        if record is None and upsert:
            self.records[query["id"]] = deepcopy(update["$setOnInsert"])
            return SimpleNamespace(upserted_id=query["id"], modified_count=0)
        if record is None:
            return SimpleNamespace(upserted_id=None, modified_count=0)
        if "$push" not in update:
            return SimpleNamespace(upserted_id=None, modified_count=0)
        if any(
            payment.get("idempotency_key") == query.get("payments.idempotency_key", {}).get("$ne")
            for payment in record.get("payments", [])
        ):
            return SimpleNamespace(upserted_id=None, modified_count=0)
        expression = query.get("$expr", {}).get("$lte")
        if expression:
            add_expression = expression[0]["$add"]
            increment = add_expression[1]
            if record.get("paid_amount_cents", 0) + increment > expression[1]:
                return SimpleNamespace(upserted_id=None, modified_count=0)
        record.update(deepcopy(update.get("$set", {})))
        record["paid_amount_cents"] += update.get("$inc", {}).get("paid_amount_cents", 0)
        record.setdefault("payments", []).append(deepcopy(update["$push"]["payments"]))
        return SimpleNamespace(upserted_id=None, modified_count=1)


class NoRecord:
    async def find_one(self, *_args, **_kwargs):
        return None


def install_endpoint_mocks(monkeypatch, *, company=None):
    account_collection = Accounts()
    plan_collection = NoRecord()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        salary_weekly_payment_accounts=account_collection,
        salary_weekly_payment_plans=plan_collection,
        salary_payments=NoRecord(),
    ))
    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    employee = {
        "employee_id": "worker-a", "name": "Worker A", "department": "Production",
        "pay_frequency": "weekly_fixed", "gross_salary": 2000, "cut": 0,
        "net_salary": 2000, "salary_rate_missing": False,
    }
    monkeypatch.setattr(
        server, "salary_report",
        lambda *_args, **_kwargs: asyncio.sleep(0, result={"employees": [employee]}),
    )

    async def no_audit(*_args, **_kwargs):
        return None

    async def insert_payment(_collection, document):
        return {"id": "legacy-payment", **document}

    monkeypatch.setattr(server, "insert", insert_payment)
    monkeypatch.setattr(server, "log_audit", no_audit)
    return account_collection, plan_collection


def weekly_request(amount, key, date="2026-11-20"):
    return server.WeeklySalaryPaymentIn(
        employee_id="worker-a", period_start="2026-11-16", period_end="2026-11-21",
        payment_date=date, amount=amount, idempotency_key=key,
    )


def test_weekly_partial_payment_retry_is_idempotent_and_overpayment_is_rejected(monkeypatch):
    accounts, plans = install_endpoint_mocks(monkeypatch)
    async def friday_plan(*_args, **_kwargs):
        return {"friday_employee_ids": ["worker-a"]}
    plans.find_one = friday_plan
    token = server.active_company_id.set(server.DEFAULT_COMPANY_ID)
    user = {"id": "owner", "_active_role": "owner", "_active_company_id": server.DEFAULT_COMPANY_ID}
    try:
        first = asyncio.run(server.record_weekly_salary_payment(
            weekly_request(1250, "worker-a-payment-01"), user,
        ))
        retry = asyncio.run(server.record_weekly_salary_payment(
            weekly_request(1250, "worker-a-payment-01"), user,
        ))
        assert retry["id"] == first["id"]
        account = accounts.records["weekly:2026-11-16:worker-a"]
        assert account["paid_amount_cents"] == 125000
        assert len(account["payments"]) == 1
        with pytest.raises(server.HTTPException) as error:
            asyncio.run(server.record_weekly_salary_payment(
                weekly_request(750.01, "worker-a-payment-02"), user,
            ))
        assert error.value.status_code == 400
        assert account["paid_amount_cents"] == 125000
    finally:
        server.active_company_id.reset(token)


def test_weekly_payment_api_is_unavailable_outside_superiqfoam(monkeypatch):
    install_endpoint_mocks(monkeypatch)
    token = server.active_company_id.set(server.MANUFACTURING_COMPANY_ID)
    try:
        with pytest.raises(server.HTTPException) as error:
            asyncio.run(server.record_weekly_salary_payment(
                weekly_request(100, "worker-a-payment-03"),
                {"id": "admin", "_active_role": "admin", "_active_company_id": server.MANUFACTURING_COMPANY_ID},
            ))
        assert error.value.status_code == 404
    finally:
        server.active_company_id.reset(token)


def test_legacy_weekly_pay_is_blocked_only_for_superiqfoam(monkeypatch):
    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    token = server.active_company_id.set(server.DEFAULT_COMPANY_ID)
    try:
        with pytest.raises(server.HTTPException) as error:
            asyncio.run(server.record_salary_payment(
                server.SalaryPaymentIn(
                    employee_id="worker-a", period_type="weekly",
                    period_start="2026-11-16", period_end="2026-11-21",
                ),
                {"id": "owner", "_active_role": "owner", "_active_company_id": server.DEFAULT_COMPANY_ID},
            ))
        assert error.value.status_code == 409
    finally:
        server.active_company_id.reset(token)


def test_saving_friday_selection_schedules_group_without_recording_payment(monkeypatch):
    class Plans:
        record = None

        async def find_one(self, _query, _projection=None):
            return deepcopy(self.record)

        async def update_one(self, _query, update, upsert=False):
            self.record = {
                **(self.record or update.get("$setOnInsert", {})),
                **deepcopy(update.get("$set", {})),
            }
            return SimpleNamespace(matched_count=1, modified_count=1)

    plans = Plans()
    accounts = Accounts()
    monkeypatch.setattr(server, "db", SimpleNamespace(
        salary_weekly_payment_plans=plans,
        salary_weekly_payment_accounts=accounts,
    ))

    async def report(*_args, **_kwargs):
        return {"employees": example_weekly_employees()[:5]}

    async def listall(collection, *_args, **_kwargs):
        if collection in {"salary_weekly_payment_accounts", "salary_payments"}:
            return []
        raise AssertionError(collection)

    async def audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "salary_report", report)
    monkeypatch.setattr(server, "listall", listall)
    monkeypatch.setattr(server, "require_admin", lambda _user: None)
    monkeypatch.setattr(server, "log_audit", audit)
    token = server.active_company_id.set(server.DEFAULT_COMPANY_ID)
    try:
        result = asyncio.run(server.save_weekly_salary_plan(
            server.WeeklySalaryPaymentPlanIn(
                period_start="2026-11-16",
                period_end="2026-11-21",
                friday_employee_ids=["worker-a", "worker-b"],
            ),
            {"id": "owner", "_active_role": "owner", "_active_company_id": server.DEFAULT_COMPANY_ID},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result["friday"]["employee_count"] == 2
    assert result["saturday"]["employee_count"] == 3
    assert result["total_paid_cents"] == 0
    assert accounts.records == {}
    assert plans.record["friday_employee_ids"] == ["worker-a", "worker-b"]


def test_weekly_salary_payment_rejects_fractional_cent_amount():
    with pytest.raises(ValidationError):
        server.WeeklySalaryPaymentIn(
            employee_id="worker-a",
            period_start="2026-11-16",
            period_end="2026-11-21",
            payment_date="2026-11-20",
            amount=10.001,
            idempotency_key="worker-a-subcent-001",
        )
def test_legacy_weekly_pay_remains_available_to_manufacturing(monkeypatch):
    _accounts, _plans = install_endpoint_mocks(monkeypatch)
    token = server.active_company_id.set(server.MANUFACTURING_COMPANY_ID)
    try:
        payment = asyncio.run(server.record_salary_payment(
            server.SalaryPaymentIn(
                employee_id="worker-a", period_type="weekly",
                period_start="2026-11-16", period_end="2026-11-21",
            ),
            {"id": "admin", "_active_role": "admin", "_active_company_id": server.MANUFACTURING_COMPANY_ID},
        ))
        assert payment["id"] == "legacy-payment"
    finally:
        server.active_company_id.reset(token)