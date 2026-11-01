import asyncio
import base64
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import server


@pytest.mark.parametrize(
    ("expiry_date", "expected_status", "expected_days"),
    [
        ("2026-11-09", "EXPIRING SOON", 8),
        ("2026-11-08", "EXPIRING SOON", 7),
        ("2026-11-02", "EXPIRING SOON", 1),
        ("2026-11-01", "EXPIRING SOON", 0),
        ("2026-10-31", "EXPIRED", -1),
    ],
)
def test_licence_disc_status_uses_calendar_days(expiry_date, expected_status, expected_days):
    assert server.vehicle_licence_disc_status(
        expiry_date, date(2026, 11, 1),
    ) == {"status": expected_status, "days_remaining": expected_days}


def test_licence_disc_status_marks_bad_historical_date_unknown():
    assert server.vehicle_licence_disc_status("not-a-date", date(2026, 11, 1)) == {
        "status": "UNKNOWN",
        "days_remaining": None,
    }

@pytest.mark.parametrize(
    ("expiry_date", "expected"),
    [
        ("2026-11-09", False),
        ("2026-11-08", True),
        ("2026-11-01", True),
        ("2026-10-31", True),
    ],
)
def test_licence_alert_threshold_is_seven_days_inclusive(expiry_date, expected):
    assert server.vehicle_licence_alert_due(expiry_date, date(2026, 11, 1)) is expected


def test_fleet_alert_recipients_are_company_scoped_and_deduplicated():
    accounts = [
        {"id": "global", "role": "owner", "email": server.os.environ["ADMIN_EMAIL"]},
        {"id": "local-owner", "role": "user", "company_roles": {"superiqfoam": "owner"}},
        {"id": "local-admin", "role": "user", "company_roles": {"superiqfoam": "admin"}},
        {"id": "other-admin", "role": "user", "company_roles": {"iqfoam-manufactoring": "admin"}},
        {"id": "worker", "role": "user", "is_worker": True, "company_roles": {"superiqfoam": "admin"}},
    ]

    recipients = server.fleet_notification_recipients(accounts, "superiqfoam")

    assert {account["id"] for account in recipients} == {"global", "local-owner", "local-admin"}


def test_licence_disc_input_requires_valid_dates_and_document_metadata():
    with pytest.raises(ValidationError):
        server.VehicleLicenceDiscIn(
            disc_number="   ",
            expiry_date="2026-11-08",
            document_name="disc.pdf",
            document_content_type="application/pdf",
            document_base64="JVBERi0=",
        )

    with pytest.raises(ValidationError):
        server.VehicleLicenceDiscIn(
            disc_number="DISC-1",
            expiry_date="08/11/2026",
            document_name="disc.pdf",
            document_content_type="application/pdf",
            document_base64="JVBERi0=",
        )

    body = server.VehicleLicenceDiscIn(
        disc_number="DISC-1",
        issue_date="",
        expiry_date="2026-11-08",
        document_name="disc.pdf",
        document_content_type="application/pdf",
        document_base64="JVBERi0=",
    )
    assert body.issue_date is None


def test_licence_upload_checks_file_signature_before_saving(monkeypatch):
    class Collection:
        def __init__(self, record=None):
            self.record = record
            self.inserted = []

        async def find_one(self, *_args, **_kwargs):
            return self.record

        async def insert_one(self, document):
            self.inserted.append(document)

    vehicles = Collection({"id": "vehicle-1"})
    discs = Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(vehicles=vehicles, vehicle_licence_discs=discs))
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    body = server.VehicleLicenceDiscIn(
        disc_number="DISC-1",
        expiry_date="2027-11-01",
        document_name='disc"\r\nunsafe.pdf',
        document_content_type="application/pdf",
        document_base64=base64.b64encode(b"not a PDF").decode("ascii"),
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.add_vehicle_licence_disc("vehicle-1", body, {"id": "user-1"}))

    assert error.value.status_code == 400
    assert discs.inserted == []


def test_licence_upload_saves_a_valid_synthetic_document(monkeypatch):
    class Collection:
        def __init__(self, record=None):
            self.record = record
            self.inserted = []

        async def find_one(self, *_args, **_kwargs):
            return self.record

        async def insert_one(self, document):
            self.inserted.append(document)

    document = b"%PDF-1.7\nsynthetic"
    vehicles = Collection({"id": "vehicle-1"})
    discs = Collection()
    monkeypatch.setattr(server, "db", SimpleNamespace(vehicles=vehicles, vehicle_licence_discs=discs))
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    body = server.VehicleLicenceDiscIn(
        disc_number="DISC-1",
        expiry_date="2027-11-01",
        document_name="disc.pdf",
        document_content_type="application/pdf",
        document_base64=base64.b64encode(document).decode("ascii"),
    )

    result = asyncio.run(server.add_vehicle_licence_disc("vehicle-1", body, {"id": "user-1"}))

    assert len(discs.inserted) == 1
    assert discs.inserted[0]["document_size"] == len(document)
    assert result["id"] == discs.inserted[0]["id"]
    assert "document_base64" not in result


def test_licence_document_download_uses_a_safe_inline_filename(monkeypatch):
    document = b"%PDF-1.7\nsynthetic"
    discs = SimpleNamespace(find_one=lambda *_args, **_kwargs: asyncio.sleep(0, result={
        "id": "disc-1",
        "vehicle_id": "vehicle-1",
        "document_base64": base64.b64encode(document).decode("ascii"),
        "document_content_type": "application/pdf",
        "document_name": 'disc"\r\nunsafe.pdf',
    }))
    monkeypatch.setattr(server, "db", SimpleNamespace(vehicle_licence_discs=discs))
    response = asyncio.run(server.get_vehicle_licence_disc_document(
        "vehicle-1", "disc-1", {"id": "user-1"},
    ))

    assert response.headers["content-disposition"] == 'inline; filename="disc___unsafe.pdf"'

    async def read_body():
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(read_body()) == document


def test_vehicle_driver_assignment_is_current_state_plus_audit_history(monkeypatch):
    class Collection:
        def __init__(self, documents):
            self.documents = documents

        async def find_one(self, query, _projection=None):
            for record in self.documents:
                if all(
                    (value.get("$ne") != record.get(key) if isinstance(value, dict) and "$ne" in value
                     else record.get(key) == value)
                    for key, value in query.items()
                ):
                    return record.copy()
            return None

        async def find_one_and_update(self, query, update, **_kwargs):
            for record in self.documents:
                if all(
                    (
                        any(
                            all(
                                (condition.get("$exists") is (field in record)
                                 if isinstance(condition, dict) and "$exists" in condition
                                 else record.get(field) == condition)
                                for field, condition in option.items()
                            )
                            for option in value
                        )
                        if key == "$or"
                        else value.get("$ne") != record.get(key)
                        if isinstance(value, dict) and "$ne" in value
                        else record.get(key) == value
                    )
                    for key, value in query.items()
                ):
                    record.update(update.get("$set", {}))
                    for key in update.get("$unset", {}):
                        record.pop(key, None)
                    for key, value in update.get("$push", {}).items():
                        record.setdefault(key, []).append(value)
                    return record.copy()
            return None

    vehicles = Collection([{"id": "vehicle-1", "name": "Truck 1", "assignment_history": []}])
    drivers = Collection([{"id": "driver-1", "name": "Driver One", "active": True}])
    monkeypatch.setattr(server, "db", SimpleNamespace(vehicles=vehicles, drivers=drivers))
    monkeypatch.setattr(server, "log_audit", lambda *_args, **_kwargs: asyncio.sleep(0))
    user = {"id": "fleet-admin"}

    assigned = asyncio.run(server.assign_vehicle_driver(
        "vehicle-1",
        server.VehicleDriverAssignmentIn(driver_id="driver-1"),
        user,
    ))
    assert assigned["assigned_driver_id"] == "driver-1"
    assert assigned["assignment_history"][0]["action"] == "assigned"

    history = asyncio.run(server.get_vehicle_assignment_history("vehicle-1", page=1, page_size=20, user=user))
    assert history["total"] == 1
    assert history["items"][0]["driver_name"] == "Driver One"

    unassigned = asyncio.run(server.assign_vehicle_driver(
        "vehicle-1",
        server.VehicleDriverAssignmentIn(driver_id=None, notes="Vehicle reassigned to workshop"),
        user,
    ))
    assert "assigned_driver_id" not in unassigned
    assert unassigned["assignment_history"][-1]["action"] == "unassigned"


def test_vehicle_driver_cannot_be_assigned_to_two_vehicles(monkeypatch):
    class Collection:
        def __init__(self, documents):
            self.documents = documents

        async def find_one(self, query, _projection=None):
            for record in self.documents:
                if all(
                    (value.get("$ne") != record.get(key) if isinstance(value, dict) and "$ne" in value
                     else record.get(key) == value)
                    for key, value in query.items()
                ):
                    return record.copy()
            return None

    vehicles = Collection([
        {"id": "vehicle-1", "name": "Truck 1", "assigned_driver_id": "driver-1"},
        {"id": "vehicle-2", "name": "Truck 2"},
    ])
    drivers = Collection([{"id": "driver-1", "name": "Driver One", "active": True}])
    monkeypatch.setattr(server, "db", SimpleNamespace(vehicles=vehicles, drivers=drivers))

    with pytest.raises(HTTPException) as error:
        asyncio.run(server.assign_vehicle_driver(
            "vehicle-2",
            server.VehicleDriverAssignmentIn(driver_id="driver-1"),
            {"id": "fleet-admin"},
        ))

    assert error.value.status_code == 409
    assert vehicles.documents[1].get("assigned_driver_id") is None


@pytest.mark.parametrize(
    ("vehicle", "unavailable_ids", "expected"),
    [
        ({"id": "v1", "available": True, "vtype": "Truck"}, set(), True),
        ({"id": "v1", "available": True, "vtype": "Truck", "assigned_driver_id": "d1"}, set(), False),
        ({"id": "v1", "available": True, "vtype": "Truck"}, {"v1"}, False),
        ({"id": "v1", "available": False, "vtype": "Truck"}, set(), False),
        ({"id": "v1", "available": True, "vtype": "Trailer"}, set(), False),
    ],
)
def test_vehicle_free_status_excludes_assigned_unavailable_and_trailer(vehicle, unavailable_ids, expected):
    assert server.vehicle_is_free(vehicle, unavailable_ids) is expected
