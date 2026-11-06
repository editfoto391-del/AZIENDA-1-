import asyncio
from copy import deepcopy

import server


class FakeCursor:
    def __init__(self, records):
        self.records = records

    async def to_list(self, length):
        return deepcopy(self.records[:length])


class FakeCollection:
    def __init__(self, records):
        self.records = records

    def find(self, query, projection=None):
        return FakeCursor([
            record for record in self.records
            if all(record.get(key) == value for key, value in query.items())
        ])

    async def find_one(self, query, projection=None):
        return deepcopy(next((
            record for record in self.records
            if all(record.get(key) == value for key, value in query.items())
        ), None))

    async def update_one(self, query, update):
        record = next((
            item for item in self.records
            if all(item.get(key) == value for key, value in query.items())
        ), None)
        if record:
            record.update(update["$set"])
        return type("UpdateResult", (), {"matched_count": int(record is not None)})()

    async def delete_one(self, query):
        self.records[:] = [
            record for record in self.records
            if not all(record.get(key) == value for key, value in query.items())
        ]


class FakeDatabase:
    def __init__(self, attendance):
        self.attendance = FakeCollection(attendance)

    def __getitem__(self, collection):
        return getattr(self, collection)


class FakeDailyCollection:
    def __init__(self):
        self.records = []

    async def find_one_and_update(self, query, update, upsert=False, return_document=None, projection=None):
        record = next((
            item for item in self.records
            if all(item.get(key) == value for key, value in query.items())
        ), None)
        if record:
            previous = deepcopy(record)
            record.update(update["$set"])
            return deepcopy(record) if return_document == server.ReturnDocument.AFTER else previous
        if not upsert:
            return None
        record = {**update.get("$setOnInsert", {}), **update["$set"], **query}
        self.records.append(record)
        return deepcopy(record) if return_document == server.ReturnDocument.AFTER else None

    async def find_one(self, query, projection=None):
        return deepcopy(next((
            record for record in self.records
            if all(record.get(key) == value for key, value in query.items())
        ), None))


class FakeEmployeeCollection:
    def __init__(self):
        self.records = [
        {"id": "employee-1", "name": "Asive Tailor"},
        {"id": "employee-2", "name": "Ayanda Tailor"},
        ]

    async def find_one(self, query, projection=None):
        return deepcopy(next((
        record for record in self.records
        if all(record.get(key) == value for key, value in query.items())
        ), None))


class FakeDailyDatabase:
    def __init__(self):
        self.attendance = FakeDailyCollection()
        self.piece_production = FakeDailyCollection()
        self.employees = FakeEmployeeCollection()

    def __getitem__(self, collection):
        return getattr(self, collection)


def test_duplicate_attendance_is_migrated_and_conflicts_are_audited(monkeypatch):
    attendance = [
        {"id": "move", "employee_id": "duplicate", "date": "2026-10-26", "status": "Present"},
        {"id": "keep", "employee_id": "retained", "date": "2026-10-27", "status": "Present"},
        {"id": "conflict", "employee_id": "duplicate", "date": "2026-10-27", "status": "Half Day"},
    ]
    database = FakeDatabase(attendance)
    audit_entries = []

    async def fake_log_audit(*args, **kwargs):
        audit_entries.append((args, kwargs))

    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "log_audit", fake_log_audit)

    asyncio.run(server.merge_duplicate_attendance(
        {"id": "duplicate"},
        {"id": "retained", "name": "ASIVE TAILOR", "department": "TAILORING (TAPE EDGE)"},
        {"id": "admin"},
    ))

    moved = next(record for record in attendance if record["id"] == "move")
    assert moved["employee_id"] == "retained"
    assert moved["employee_name"] == "ASIVE TAILOR"
    assert moved["department"] == "TAILORING (TAPE EDGE)"
    assert {record["id"] for record in attendance} == {"move", "keep"}
    assert len(audit_entries) == 1
    assert audit_entries[0][0][2] == "duplicate_attendance_conflict_archived"
    assert audit_entries[0][1]["before"]["status"] == "Half Day"


def test_employee_day_saves_upsert_without_replacing_record_identity(monkeypatch):
    database = FakeDailyDatabase()
    monkeypatch.setattr(server, "db", database)

    async def save_twice():
        previous, created = await server._save_employee_day_record(
            "piece_production", "ayanda", "2026-10-26",
            {"employee_id": "ayanda", "date": "2026-10-26", "pieces": 72},
        )
        updated_previous, updated = await server._save_employee_day_record(
            "piece_production", "ayanda", "2026-10-26",
            {"employee_id": "ayanda", "date": "2026-10-26", "pieces": 80},
        )
        return previous, created, updated_previous, updated

    previous, created, updated_previous, updated = asyncio.run(save_twice())

    assert previous is None
    assert created["pieces"] == 72
    assert updated_previous["pieces"] == 72
    assert updated["pieces"] == 80
    assert updated["id"] == created["id"]
    assert updated["created_at"] == created["created_at"]
    assert len(database.piece_production.records) == 1


def test_attendance_endpoint_updates_the_existing_employee_day(monkeypatch):
    database = FakeDailyDatabase()
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server, "emit_workflow_event", lambda *args: asyncio.sleep(0))

    async def save_twice():
        present = await server.add_attendance(
            server.AttendanceIn(employee_id="employee-1", date="2026-10-26", status="Present"),
            {"id": "admin"},
        )
        absent = await server.add_attendance(
            server.AttendanceIn(employee_id="employee-1", date="2026-10-26", status="Absent"),
            {"id": "admin"},
        )
        return present, absent

    present, absent = asyncio.run(save_twice())

    assert present["id"] == absent["id"]
    assert absent["status"] == "Absent"
    assert len(database.attendance.records) == 1


def test_piecework_endpoint_saves_asive_tailor_even_without_piece_pay_flag(monkeypatch):
    database = FakeDailyDatabase()
    audit_actions = []
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(
        server, "piecework_week_snapshot",
        lambda *args: asyncio.sleep(0, result={"pay": 0}),
    )
    monkeypatch.setattr(
        server, "log_audit",
        lambda _entity, _record_id, action, *_args, **_kwargs: (
            audit_actions.append(action) or asyncio.sleep(0)
        ),
    )
    monkeypatch.setattr(server, "emit_workflow_event", lambda *args: asyncio.sleep(0))

    async def save_twice():
        created = await server.save_piece_production(
            server.PieceProductionIn(employee_id="employee-1", date="2026-10-26", pieces=72),
            {"id": "admin"},
        )
        updated = await server.save_piece_production(
            server.PieceProductionIn(employee_id="employee-1", date="2026-10-26", pieces=80),
            {"id": "admin"},
        )
        return created, updated

    created, updated = asyncio.run(save_twice())

    assert created["id"] == updated["id"]
    assert updated["pieces"] == 80
    assert [record["employee_name"] for record in database.piece_production.records] == ["Asive Tailor"]
    assert audit_actions == [
        "created_weekly_payroll_calculated",
        "updated_weekly_payroll_recalculated",
    ]


def test_piecework_sunday_exclusion_ignores_name_spacing_and_case():
    assert not server.piecework_includes_sunday("  Asive   Tailor ")
    assert not server.piecework_includes_sunday("ayanda tailor")
    assert server.piecework_includes_sunday("Ayanda Bhai")
