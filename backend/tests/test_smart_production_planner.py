import pytest

from smart_production_planner import build_smart_production_plan


def order(order_id, quantity, *, status="To Send", reference=None, category="Candy", size="1070x100"):
    return {
        "id": order_id,
        "reference": reference or order_id.upper(),
        "customer_name": "Customer " + order_id,
        "status": status,
        "items": [{"qty": quantity, "category": category, "size": size}],
    }


def stock(quantity, *, product="Candy", size="1070x100"):
    return [{"id": "stock-1", "product": product, "size": size, "current": quantity}]


def test_single_order_uses_existing_stock_without_mutating_business_records():
    plan = build_smart_production_plan(
        [order("a", 5)],
        [order("a", 5)],
        stock(2),
        [],
    )

    assert plan["orders"] == [{
        "order_id": "a",
        "reference": "A",
        "customer_name": "Customer a",
        "required_quantity": 5,
        "available_quantity": 2,
        "missing_quantity": 3,
        "ready": False,
        "has_production_items": True,
        "unresolved": False,
    }]
    assert plan["total_required"] == 5
    assert plan["total_available"] == 2
    assert plan["total_missing"] == 3
    assert plan["mutates_inventory"] is False
    assert plan["mutates_production"] is False
    assert plan["mutates_orders"] is False
    assert plan["mutates_piecework"] is False


def test_identical_requirements_are_consolidated_and_allocated_to_each_order_once():
    first = order("a", 2)
    second = order("b", 3)
    plan = build_smart_production_plan(
        [first, second],
        [first, second],
        stock(3),
        [],
    )

    assert len(plan["lines"]) == 1
    line = plan["lines"][0]
    assert line["total_required"] == 5
    assert [
        (allocation["order_id"], allocation["available_quantity"], allocation["missing_quantity"])
        for allocation in line["orders"]
    ] == [("a", 2, 0), ("b", 1, 2)]
    assert plan["stock_reservations"][0]["quantity"] == 2
    assert plan["stock_reservations"][0]["quantity"] + plan["stock_reservations"][1]["quantity"] == 3


def test_other_open_orders_and_existing_plans_reserve_stock():
    selected = order("selected", 4)
    other = order("other", 3)
    already_planned = order("planned", 2)
    plan = build_smart_production_plan(
        [selected],
        [selected, other, already_planned],
        stock(10),
        [],
        active_arrangements=[{
            "status": "active",
            "order_ids": ["planned"],
            "stock_reservations": [{
                "product": "Candy",
                "size": "1070x100",
                "quantity": 2,
            }],
        }],
    )

    assert plan["lines"][0]["available_quantity"] == 5
    assert plan["orders"][0]["missing_quantity"] == 0
    assert plan["orders"][0]["ready"] is True


def test_unknown_other_open_order_fails_closed_for_stock_availability():
    selected = order("selected", 1)
    unknown = {
        "id": "unknown",
        "reference": "UNKNOWN",
        "status": "Preparing",
        "items": [{"qty": 2, "category": "Candy"}],
    }
    plan = build_smart_production_plan(
        [selected],
        [selected, unknown],
        stock(100),
        [],
    )

    assert plan["lines"][0]["available_quantity"] == 0
    assert plan["lines"][0]["missing_quantity"] == 1
    assert any("incomplete product requirements" in warning for warning in plan["warnings"])


def test_ribbon_shortage_is_distributed_to_existing_named_employees_with_order_references():
    ribbon_order = order("ribbon-order", 8, category="Ribbon Black", size="1070x100")
    employees = [
        {"id": "asive", "name": "ASIVE TAILOR"},
        {"id": "ayanda", "name": "AYANDA TAILOR"},
        {"id": "hassan", "name": "HASSAN TAILOR"},
    ]
    plan = build_smart_production_plan(
        [ribbon_order],
        [ribbon_order],
        stock(2, product="Ribbon Black"),
        employees,
    )

    tasks = plan["employee_tasks"]
    assert [task["employee_name"] for task in tasks] == [
        "ASIVE TAILOR", "AYANDA TAILOR", "HASSAN TAILOR",
    ]
    assert [task["total_pieces"] for task in tasks] == [2, 2, 2]
    assert sum(task["total_pieces"] for task in tasks) == 6
    assert all(
        task["tasks"][0]["orders"] == [{
            "order_id": "ribbon-order",
            "order_reference": "RIBBON-ORDER",
            "customer_name": "Customer ribbon-order",
            "quantity": 2,
        }]
        for task in tasks
    )


def test_same_product_and_size_across_orders_shows_one_total_with_order_breakdown():
    first = order("first", 60, reference="ORDER-X", category="Ribbon Black", size="910x100")
    second = order("second", 10, reference="ORDER-Y", category="Ribbon Black", size="910x100")
    employees = [
        {"id": "asive", "name": "ASIVE TAILOR"},
        {"id": "ayanda", "name": "AYANDA TAILOR"},
        {"id": "hassan", "name": "HASSAN TAILOR"},
    ]

    plan = build_smart_production_plan([first, second], [first, second], [], employees)

    assert len(plan["lines"]) == 1
    line = plan["lines"][0]
    assert (line["missing_quantity"], line["size"], line["product"]) == (
        70, "910x100", "Ribbon Black",
    )
    assigned_tasks = [
        task
        for employee in plan["employee_tasks"]
        for task in employee["tasks"]
    ]
    assert len(assigned_tasks) == 3
    assert sum(task["quantity"] for task in assigned_tasks) == 70
    assert {
        order["order_reference"]
        for task in assigned_tasks
        for order in task["orders"]
    } == {"ORDER-X", "ORDER-Y"}
    assert sum(
        order["quantity"]
        for task in assigned_tasks
        for order in task["orders"]
        if order["order_reference"] == "ORDER-X"
    ) == 60
    assert sum(
        order["quantity"]
        for task in assigned_tasks
        for order in task["orders"]
        if order["order_reference"] == "ORDER-Y"
    ) == 10


def test_simple_shortage_is_not_assigned_to_the_named_production_team():
    simple_order = order("simple", 8, category="Simple")
    plan = build_smart_production_plan(
        [simple_order],
        [simple_order],
        stock(0),
        [
            {"id": "asive", "name": "ASIVE TAILOR"},
            {"id": "ayanda", "name": "AYANDA TAILOR"},
            {"id": "hassan", "name": "HASSAN TAILOR"},
        ],
    )

    assert "block_cutting" not in plan
    assert plan["employee_tasks"] == [
        {"employee_id": employee_id, "employee_name": name, "tasks": [], "total_pieces": 0}
        for employee_id, name in (
            ("asive", "ASIVE TAILOR"),
            ("ayanda", "AYANDA TAILOR"),
            ("hassan", "HASSAN TAILOR"),
        )
    ]
    assert plan["lines"] == []


def test_candy_strong_boy_and_both_ribbon_colours_are_assigned_to_named_employees():
    selected = {
        "id": "team-orders",
        "reference": "TEAM-ORDERS",
        "status": "To Send",
        "items": [
            {"qty": 2, "category": "Candy", "size": "910x100"},
            {"qty": 2, "category": "Strong Boy", "size": "1070x125"},
            {"qty": 2, "category": "Ribbon Black", "size": "1070x100"},
            {"qty": 2, "category": "Ribbon Pink", "size": "1070x100"},
        ],
    }
    employees = [
        {"id": "asive", "name": "ASIVE TAILOR"},
        {"id": "ayanda", "name": "AYANDA TAILOR"},
        {"id": "hassan", "name": "HASSAN TAILOR"},
    ]

    plan = build_smart_production_plan([selected], [selected], [], employees)

    assigned_tasks = [
        task
        for employee in plan["employee_tasks"]
        for task in employee["tasks"]
    ]
    assert {task["product"] for task in assigned_tasks} == {
        "Candy", "Strong Boy", "Ribbon Black", "Ribbon Pink",
    }
    assert sum(task["quantity"] for task in assigned_tasks) == 8
    assert all(
        all(order["order_reference"] == "TEAM-ORDERS" for order in task["orders"])
        for task in assigned_tasks
    )


def test_revalidation_uses_actual_stock_after_existing_production_receipt():
    selected = order("a", 5)
    before = build_smart_production_plan([selected], [selected], stock(1), [])
    after = build_smart_production_plan([selected], [selected], stock(4), [])

    assert before["total_missing"] == 4
    assert after["total_missing"] == 1
    assert after["total_available"] == 4


def test_duplicate_order_ids_are_rejected():
    selected = order("a", 1)
    with pytest.raises(ValueError, match="cannot be arranged twice"):
        build_smart_production_plan([selected, selected], [selected], stock(1), [])


def test_unparseable_selected_order_lines_require_manual_review():
    selected = {
        "id": "unknown",
        "reference": "UNKNOWN",
        "status": "To Send",
        "items": [{"qty": 2, "category": "Candy"}],
    }
    plan = build_smart_production_plan([selected], [selected], stock(100), [])

    assert plan["lines"] == []
    assert plan["unresolved_lines"][0]["order_reference"] == "UNKNOWN"
    assert plan["orders"][0]["ready"] is False
