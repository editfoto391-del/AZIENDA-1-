import asyncio

import pytest

from grv_math import (
    aggregate_accepted_stock_lines,
    grv_confirmation_status,
    validate_grv_line_quantities,
)


def test_grv_rejects_accepted_and_rejected_quantity_over_actual():
    with pytest.raises(ValueError, match="cannot exceed actual"):
        validate_grv_line_quantities({
            "actual_received_quantity": 5,
            "accepted_quantity": 4,
            "rejected_quantity": 2,
            "damaged_quantity": 0,
            "unit_cost": 10,
        })


def test_grv_rejects_damaged_quantity_above_rejected_quantity():
    with pytest.raises(ValueError, match="cannot exceed rejected"):
        validate_grv_line_quantities({
            "actual_received_quantity": 5,
            "accepted_quantity": 3,
            "rejected_quantity": 2,
            "damaged_quantity": 3,
            "unit_cost": 10,
        })


def test_grv_calculates_accepted_value_and_limits_po_receipt():
    result = validate_grv_line_quantities({
        "actual_received_quantity": 5,
        "accepted_quantity": 3,
        "rejected_quantity": 2,
        "damaged_quantity": 1,
        "unit_cost": 12.5,
    }, remaining=5)

    assert result["total_value"] == 37.5

    with pytest.raises(ValueError, match="remaining quantity"):
        validate_grv_line_quantities({
            "actual_received_quantity": 6,
            "accepted_quantity": 6,
            "rejected_quantity": 0,
            "damaged_quantity": 0,
            "unit_cost": 12.5,
        }, remaining=5)


def test_confirmed_grv_creates_one_stock_group_per_unique_stock_id():
    movements = aggregate_accepted_stock_lines([
        {"stock_id": "foam-910", "product": "Simple", "size": "910x100",
         "accepted_quantity": 2, "unit_cost": 100},
        {"stock_id": "foam-910", "product": "Simple", "size": "910x100",
         "accepted_quantity": 3, "unit_cost": 120},
        {"stock_id": "foam-1200", "product": "Simple", "size": "1200x100",
         "accepted_quantity": 1, "unit_cost": 150},
        {"stock_id": "foam-rejected", "product": "Simple", "size": "Rejected",
         "accepted_quantity": 0, "unit_cost": 90},
    ])

    assert len(movements) == 2
    assert movements[0]["stock_id"] == "foam-910"
    assert movements[0]["quantity"] == 5
    assert movements[0]["unit_cost"] == 112
    assert movements[1]["stock_id"] == "foam-1200"


def test_grv_status_tracks_discrepancies_and_partial_orders():
    lines = [{
        "rejected_quantity": 0,
        "damaged_quantity": 0,
    }]
    assert grv_confirmation_status(lines, purchase_order_complete=False) == "partially_received"
    assert grv_confirmation_status(lines, purchase_order_complete=True) == "completed"
    assert grv_confirmation_status(
        [{**lines[0], "rejected_quantity": 1}], purchase_order_complete=True,
    ) == "discrepancy"


def test_legacy_purchase_order_receiving_endpoint_is_disabled_without_database_writes():
    from fastapi import HTTPException
    from server import receive_purchase_order

    with pytest.raises(HTTPException) as error:
        asyncio.run(receive_purchase_order("po-legacy", user={"email": "worker@example.test"}))

    assert error.value.status_code == 409
    assert "Create and confirm a GRV" in error.value.detail
