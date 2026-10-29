import math
from decimal import Decimal, ROUND_HALF_UP


def validate_grv_line_quantities(line, *, remaining=None):
    actual = float(line.get("actual_received_quantity", 0))
    accepted = float(line.get("accepted_quantity", 0))
    rejected = float(line.get("rejected_quantity", 0))
    damaged = float(line.get("damaged_quantity", 0))
    unit_cost = float(line.get("unit_cost", 0))
    values = (actual, accepted, rejected, damaged, unit_cost)
    if any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("GRV quantities and unit cost must be finite and non-negative")
    actual_decimal = Decimal(str(actual))
    accepted_decimal = Decimal(str(accepted))
    rejected_decimal = Decimal(str(rejected))
    damaged_decimal = Decimal(str(damaged))
    unit_cost_decimal = Decimal(str(unit_cost))
    if accepted_decimal + rejected_decimal > actual_decimal:
        raise ValueError("Accepted and rejected quantities cannot exceed actual received quantity")
    if damaged_decimal > rejected_decimal:
        raise ValueError("Damaged quantity cannot exceed rejected quantity")
    if remaining is not None and actual_decimal > Decimal(str(remaining)):
        raise ValueError(f"Actual received quantity cannot exceed the remaining quantity ({remaining:g})")
    total_value = (accepted_decimal * unit_cost_decimal).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP,
    )
    return {
        "actual_received_quantity": actual,
        "accepted_quantity": accepted,
        "rejected_quantity": rejected,
        "damaged_quantity": damaged,
        "unit_cost": unit_cost,
        "total_value": float(total_value),
    }


def aggregate_accepted_stock_lines(lines):
    grouped = {}
    for line in lines:
        quantity = float(line.get("accepted_quantity", 0))
        if quantity <= 0:
            continue
        stock_id = line["stock_id"]
        row = grouped.setdefault(stock_id, {
            "stock_id": stock_id,
            "product": line["product"],
            "size": line.get("size", ""),
            "quantity": 0.0,
            "total_value": 0.0,
        })
        row["quantity"] = round(row["quantity"] + quantity, 4)
        line_value = Decimal(str(line.get("total_value", quantity * float(line.get("unit_cost", 0))))).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP,
        )
        row["total_value"] = float(
            (Decimal(str(row["total_value"])) + line_value).quantize(
                 Decimal("0.01"), rounding=ROUND_HALF_UP,
             )
        )
    for row in grouped.values():
        row["unit_cost"] = (
            float(
                (Decimal(str(row["total_value"])) / Decimal(str(row["quantity"]))).quantize(
                    Decimal("0.0001"), rounding=ROUND_HALF_UP,
                )
            ) if row["quantity"] else 0
        )
    return list(grouped.values())


def grv_confirmation_status(lines, purchase_order_complete):
    has_discrepancy = any(
        line.get("rejected_quantity", 0) > 0
        or line.get("damaged_quantity", 0) > 0
        for line in lines
    )
    if has_discrepancy:
        return "discrepancy"
    return "completed" if purchase_order_complete else "partially_received"
