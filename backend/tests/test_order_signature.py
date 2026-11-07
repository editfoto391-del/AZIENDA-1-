import asyncio
import base64
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


PNG_DATA = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2cAAAAASUVORK5CYII="
)


def test_driver_confirmation_request_trims_name_and_requires_acknowledgement():
    request = server.DriverDeliveryConfirmationIn(
        signature_data=PNG_DATA, driver_name="  Alex  ", driver_confirmed=True,
    )
    assert request.driver_name == "Alex"

    with pytest.raises(ValueError, match="Driver name is required"):
        server.DriverDeliveryConfirmationIn(
            signature_data=PNG_DATA, driver_name="   ", driver_confirmed=True,
        )
    with pytest.raises(ValueError, match="Driver must confirm the loaded items"):
        server.DriverDeliveryConfirmationIn(
            signature_data=PNG_DATA, driver_name="Alex", driver_confirmed=False,
        )


def test_validate_driver_signature_image_enforces_png_and_size():
    with pytest.raises(HTTPException) as invalid:
        server.validate_signature_png("data:image/jpeg;base64,Zm9v")
    assert invalid.value.status_code == 422

    oversized_png = b"\x89PNG\r\n\x1a\n" + (b"x" * (128 * 1024))
    payload = "data:image/png;base64," + base64.b64encode(oversized_png).decode()
    with pytest.raises(HTTPException) as oversized:
        server.validate_signature_png(payload)
    assert oversized.value.status_code == 413


def test_save_driver_confirmation_is_one_time_and_records_order_snapshot(monkeypatch):
    stored = {
        "id": "order-1",
        "reference": "ORD-2026-0001",
        "invoice_id": "invoice-1",
        "invoice_number": "INV-101",
        "customer_id": "customer-1",
        "items": [{"qty": 2, "category": "Foam", "size": "910x100"}],
        "products": "",
    }
    audit_calls = []

    class Orders:
        async def find_one(self, *_args, **_kwargs):
            return deepcopy(stored)

        async def update_one(self, query, update):
            if stored.get("signature_data"):
                return SimpleNamespace(matched_count=0)
            stored.update(update["$set"])
            return SimpleNamespace(matched_count=1)

    class Invoices:
        async def find_one(self, *_args, **_kwargs):
            return {
                "number": "INV-101",
                "customer_id": "customer-1",
                "items": [{"qty": 2, "category": "Foam", "size": "910x100"}],
            }

    async def record_audit(*args, **kwargs):
        audit_calls.append((args, kwargs))

    monkeypatch.setattr(server, "db", SimpleNamespace(orders=Orders(), invoices=Invoices()))
    monkeypatch.setattr(server, "log_audit", record_audit)
    monkeypatch.setattr(server, "now_iso", lambda: "2026-11-07T09:00:00+00:00")
    body = server.DriverDeliveryConfirmationIn(
        signature_data=PNG_DATA, driver_name="Alex", driver_confirmed=True,
    )

    saved = asyncio.run(server.save_order_driver_confirmation("order-1", body, {"id": "user-1"}))
    assert saved["driver_name"] == "Alex"
    assert saved["confirmed_at"] == "2026-11-07T09:00:00+00:00"
    assert saved["confirmation_snapshot"] == {
        "order_reference": "ORD-2026-0001",
        "invoice_id": "invoice-1",
        "invoice_number": "INV-101",
        "invoice_snapshot": {
            "invoice_number": "INV-101",
            "items": [{"qty": 2, "category": "Foam", "size": "910x100"}],
        },
        "items": [{"qty": 2, "category": "Foam", "size": "910x100"}],
        "products": "",
        "driver_confirmed_items_match": True,
    }
    assert stored["driver_signature_data"] == PNG_DATA
    assert audit_calls[0][0][2] == "driver_confirmed_delivery_items"
    assert PNG_DATA not in str(audit_calls[0])

    with pytest.raises(HTTPException) as duplicate:
        asyncio.run(server.save_order_driver_confirmation("order-1", body, {"id": "user-1"}))
    assert duplicate.value.status_code == 409
