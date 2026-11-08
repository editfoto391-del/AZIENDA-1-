import math
import re
from collections import defaultdict


OPEN_ORDER_STATUSES = {"To Send", "Preparing", "Assigned", "Partially Delivered"}
PRODUCTION_EMPLOYEE_NAMES = ("ASIVE TAILOR", "AYANDA TAILOR", "HASSAN TAILOR")


def _text(value):
    return " ".join(str(value or "").split())


def _normalized(value):
    return _text(value).casefold()


def _size_key(value):
    value = _normalized(value)
    return re.sub(r"\s*[x×]\s*", "x", value)


def _infer_color(product):
    normalized = _normalized(product)
    if "pink" in normalized:
        return "Pink"
    if "black" in normalized:
        return "Black"
    if "mix color" in normalized or "mixed color" in normalized:
        return "Mix color"
    return ""


def _infer_type(product):
    normalized = _normalized(product)
    if "ribbon" in normalized:
        return "RIBBON"
    if "simple" in normalized or "standard" in normalized:
        return "SIMPLE"
    return "OTHER"


def _is_employee_production_product(product):
    normalized = re.sub(r"[^a-z0-9]+", "", _normalized(product))
    return normalized in {"candy", "strongboy", "ribbonblack", "ribbonpink"}


def _identity(item):
    product = _text(item.get("category") or item.get("product") or item.get("description"))
    size = _text(item.get("size") or item.get("dimensions"))
    color = _text(item.get("color") or item.get("colour") or _infer_color(product))
    product_type = _text(item.get("product_type") or item.get("type") or _infer_type(product)).upper()
    key = (
        _normalized(product),
        _size_key(size),
        _normalized(color),
        _normalized(product_type),
    )
    return key, {
        "product": product,
        "size": size,
        "color": color,
        "product_type": product_type,
    }


def _order_lines(order):
    items = order.get("items")
    if isinstance(items, list) and items:
        return items
    raw_products = order.get("products")
    if not isinstance(raw_products, str):
        return []
    lines = []
    for raw in re.split(r"[\n,]", raw_products):
        match = re.match(r"^\s*(\d+)\s*[x×]?\s*(.*?)\s*$", raw, re.IGNORECASE)
        if match:
            label = match.group(2)
            dimension_match = re.search(r"\b\d+\s*[x×]\s*\d+(?:\s*[x×]\s*\d+)?\b", label, re.IGNORECASE)
            size = dimension_match.group(0) if dimension_match else ""
            product = (label[:dimension_match.start()] + label[dimension_match.end():]).strip() if dimension_match else label
            lines.append({"qty": int(match.group(1)), "category": product, "size": size})
        elif raw.strip():
            lines.append({"qty": None, "category": raw.strip(), "size": ""})
    return lines


def _quantity(value):
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(amount) or amount <= 0 or not amount.is_integer():
        return None
    return int(amount)


def build_smart_production_plan(
    selected_orders,
    all_orders,
    stock,
    employees,
    active_arrangements=(),
):
    order_ids = [str(order.get("id") or "") for order in selected_orders]
    if not order_ids or any(not order_id for order_id in order_ids):
        raise ValueError("Select at least one valid order.")
    if len(set(order_ids)) != len(order_ids):
        raise ValueError("The same order cannot be arranged twice.")
    for order in selected_orders:
        if order.get("archived") or order.get("status") not in OPEN_ORDER_STATUSES:
            raise ValueError(f"Order {order.get('reference') or order.get('id')} is no longer available for planning.")

    orders_by_id = {str(order.get("id") or ""): order for order in all_orders}
    selected_ids = set(order_ids)
    planned_order_ids = {
        str(order_id)
        for arrangement in active_arrangements
        if arrangement.get("status") == "active"
        for order_id in arrangement.get("order_ids", [])
    }

    requirement_by_key = {}
    unresolved = []
    selected_by_order = defaultdict(list)

    def collect(order, target, *, selected):
        order_id = str(order.get("id") or "")
        for line_number, line in enumerate(_order_lines(order), start=1):
            key, identity = _identity(line)
            if identity["product"] and not _is_employee_production_product(identity["product"]):
                continue
            quantity = _quantity(line.get("qty"))
            if not quantity or not identity["product"] or not identity["size"]:
                unresolved.append({
                    "order_id": order_id,
                    "order_reference": order.get("reference") or order_id,
                    "customer_name": order.get("customer_name", ""),
                    "line_number": line_number,
                    "description": identity["product"] or _text(line.get("description")),
                    "reason": "Quantity, exact product, or exact dimensions are missing or invalid.",
                })
                continue
            item = target.setdefault(key, {
                **identity,
                "key": key,
                "quantity": 0,
                "orders": [],
            })
            item["quantity"] += quantity
            if selected:
                allocation = {
                    "order_id": order_id,
                    "order_reference": order.get("reference") or order_id,
                    "customer_name": order.get("customer_name", ""),
                    "quantity": quantity,
                    "available_quantity": 0,
                    "missing_quantity": quantity,
                }
                item["orders"].append(allocation)
                selected_by_order[order_id].append(allocation)

    for order in selected_orders:
        collect(order, requirement_by_key, selected=True)

    reservations = defaultdict(int)
    for arrangement in active_arrangements:
        if arrangement.get("status") != "active":
            continue
        if selected_ids.intersection(str(value) for value in arrangement.get("order_ids", [])):
            continue
        for reservation in arrangement.get("stock_reservations", []):
            key, _ = _identity(reservation)
            reservations[key] += _quantity(reservation.get("quantity")) or 0

    other_requirements = {}
    unknown_other_order_demand = False
    for order in all_orders:
        order_id = str(order.get("id") or "")
        if (
            order_id in selected_ids
            or order_id in planned_order_ids
            or order.get("archived")
            or order.get("status") not in OPEN_ORDER_STATUSES
        ):
            continue
        unresolved_before = len(unresolved)
        collect(order, other_requirements, selected=False)
        unknown_other_order_demand = unknown_other_order_demand or len(unresolved) > unresolved_before

    available_by_key = defaultdict(int)
    for stock_item in stock:
        key, identity = _identity(stock_item)
        if not identity["product"] or not identity["size"]:
            continue
        try:
            current = max(0, math.floor(float(stock_item.get("current", 0))))
        except (TypeError, ValueError):
            current = 0
        available_by_key[key] += current

    lines = []
    stock_reservations = []
    total_required = 0
    total_available = 0
    for key, requirement in requirement_by_key.items():
        reserved_for_orders = other_requirements.get(key, {}).get("quantity", 0)
        available = 0 if unknown_other_order_demand else max(
            0,
            available_by_key.get(key, 0) - reserved_for_orders - reservations.get(key, 0),
        )
        total_required += requirement["quantity"]
        row = {key_name: requirement[key_name] for key_name in ("product", "size", "color", "product_type")}
        row.update({
            "key": list(key),
            "total_required": requirement["quantity"],
            "available_quantity": available,
            "missing_quantity": max(0, requirement["quantity"] - available),
            "orders": requirement["orders"],
        })
        remaining = available
        for allocation in row["orders"]:
            from_stock = min(remaining, allocation["quantity"])
            allocation["available_quantity"] = from_stock
            allocation["missing_quantity"] = allocation["quantity"] - from_stock
            remaining -= from_stock
            total_available += from_stock
            if from_stock:
                stock_reservations.append({**row, "quantity": from_stock})
        row["status"] = (
            "ready" if row["missing_quantity"] == 0
            else "partial" if row["available_quantity"] > 0
            else "pending"
        )
        lines.append(row)

    employees_by_name = {
        _normalized(employee.get("name")).upper(): employee
        for employee in employees
        if employee.get("active", True) is not False
    }
    production_employees = [
        employees_by_name[name]
        for name in PRODUCTION_EMPLOYEE_NAMES
        if name in employees_by_name
    ]
    employee_tasks = {employee["id"]: {
        "employee_id": employee["id"],
        "employee_name": employee.get("name", ""),
        "tasks": [],
        "total_pieces": 0,
    } for employee in production_employees}
    employee_load = {employee["id"]: 0 for employee in production_employees}
    unassigned_employee_quantity = 0
    for line in lines:
        if line["missing_quantity"] <= 0:
            continue
        missing_by_order = [
            allocation for allocation in line["orders"]
            if allocation["missing_quantity"] > 0
        ]
        quantity_to_assign = sum(allocation["missing_quantity"] for allocation in missing_by_order)
        if not production_employees:
            unassigned_employee_quantity += quantity_to_assign
            continue
        base, remainder = divmod(quantity_to_assign, len(production_employees))
        shares = {employee["id"]: base for employee in production_employees}
        for employee in sorted(production_employees, key=lambda item: (employee_load[item["id"]], item["id"]))[:remainder]:
            shares[employee["id"]] += 1
        remaining_by_order = [
            {**allocation, "remaining_quantity": allocation["missing_quantity"]}
            for allocation in missing_by_order
        ]
        for employee in production_employees:
            assigned = shares[employee["id"]]
            if assigned <= 0:
                continue
            assigned_orders = []
            remaining_assignment = assigned
            for allocation in remaining_by_order:
                if remaining_assignment <= 0:
                    break
                from_order = min(remaining_assignment, allocation["remaining_quantity"])
                if from_order <= 0:
                    continue
                assigned_orders.append({
                    "order_id": allocation["order_id"],
                    "order_reference": allocation["order_reference"],
                    "customer_name": allocation["customer_name"],
                    "quantity": from_order,
                })
                allocation["remaining_quantity"] -= from_order
                remaining_assignment -= from_order
            employee_tasks[employee["id"]]["tasks"].append({
                "product": line["product"],
                "size": line["size"],
                "color": line["color"],
                "product_type": line["product_type"],
                "quantity": assigned,
                "orders": assigned_orders,
            })
            employee_tasks[employee["id"]]["total_pieces"] += assigned
            employee_load[employee["id"]] += assigned

    order_summaries = []
    for order in selected_orders:
        order_id = str(order.get("id") or "")
        order_lines = selected_by_order[order_id]
        required = sum(line["quantity"] for line in order_lines)
        available = sum(line["available_quantity"] for line in order_lines)
        missing = sum(line["missing_quantity"] for line in order_lines)
        unresolved_for_order = any(line["order_id"] == order_id for line in unresolved)
        order_summaries.append({
            "order_id": order_id,
            "reference": order.get("reference") or order_id,
            "customer_name": order.get("customer_name", ""),
            "required_quantity": required,
            "available_quantity": available,
            "missing_quantity": missing,
            "ready": required > 0 and missing == 0 and not unresolved_for_order,
            "has_production_items": required > 0,
            "unresolved": unresolved_for_order,
        })

    warnings = []
    if unresolved:
        warnings.append("Some order lines do not contain a valid quantity, product, or exact dimensions.")
    if other_requirements:
        warnings.append("Available stock is reduced by the full demand of other open, unplanned orders because the current order system has no partial-shipment allocation data.")
    if unknown_other_order_demand:
        warnings.append("Stock availability is set to zero because another open order has incomplete product requirements that cannot be safely reserved.")
    if unassigned_employee_quantity:
        warnings.append(f"{unassigned_employee_quantity} pieces have no active ASIVE TAILOR, AYANDA TAILOR, or HASSAN TAILOR profile for assignment.")

    return {
        "order_ids": order_ids,
        "orders": order_summaries,
        "lines": lines,
        "total_required": total_required,
        "total_available": total_available,
        "total_missing": max(0, total_required - total_available),
        "ready_orders": [order for order in order_summaries if order["ready"]],
        "employee_tasks": list(employee_tasks.values()),
        "unassigned_employee_quantity": unassigned_employee_quantity,
        "unresolved_lines": unresolved,
        "stock_reservations": stock_reservations,
        "warnings": warnings,
        "mutates_inventory": False,
        "mutates_production": False,
        "mutates_orders": False,
        "mutates_piecework": False,
    }
