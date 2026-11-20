from datetime import date

import server


def test_company_inventory_low_stock_threshold_uses_highest_recorded_quantity():
    item = {
        "packages": 0,
        "loose_units": 18,
        "stock_reference_quantity": 100,
    }

    assert server.company_inventory_low_stock_threshold(item) == 20
    assert server.company_inventory_low_stock_threshold(item, 50) == 10


def test_product_stock_warning_thresholds_are_scoped_to_requested_products_and_sizes():
    assert server.stock_warning_threshold({"product": "Simple", "size": "910x100"}) == 150
    assert server.stock_warning_threshold({"product": "simple", "size": "760 × 100"}) == 150
    assert server.stock_warning_threshold({"product": "SIMPLE", "size": "1070x100"}) == 100
    assert server.stock_warning_threshold({"product": "Ribbon Black", "size": "760x50"}) == 150
    assert server.stock_warning_threshold({"product": "Ribbon Pink", "size": "1370x150"}) == 150
    assert server.stock_warning_threshold({"product": "Candy", "size": "910x100"}) is None


def test_product_stock_warnings_trigger_strictly_below_threshold():
    for product, size, threshold in (
        ("Simple", "910x100", 150),
        ("Simple", "1070x100", 100),
        ("Ribbon Black", "760x50", 150),
        ("Ribbon Pink", "910x150", 150),
    ):
        assert server.stock_warning_is_active({
            "product": product, "size": size, "current": threshold - 1,
        })
        assert not server.stock_warning_is_active({
            "product": product, "size": size, "current": threshold,
        })


def test_product_stock_warning_keeps_existing_threshold_behavior_for_other_products():
    item = {"product": "Candy", "size": "910x100", "current": 10, "threshold": 10}

    assert not server.stock_warning_is_active(item)
    assert server.stock_warning_is_active(item, include_equal_for_existing_threshold=True)


def test_chemical_low_stock_threshold_uses_three_days_of_recent_usage_or_twenty_percent():
    logs = [
        {
            "date": f"2026-11-0{day}",
            "lines": [{
                "chemical": "Resin",
                "unit": "kg",
                "initial_quantity": 100 if day == 1 else None,
                "used_quantity": 7,
                "remaining_estimate": 100 - day * 7,
            }],
        }
        for day in range(1, 8)
    ]

    threshold = server.chemical_low_stock_threshold(
        logs, " resin ", "KG", date(2026, 11, 7),
    )

    assert threshold == 21


def test_chemical_low_stock_threshold_keeps_material_units_separate():
    logs = [{
        "date": "2026-11-03",
        "lines": [
            {"chemical": "Resin", "unit": "kg", "initial_quantity": 100, "used_quantity": 0, "remaining_estimate": 50},
            {"chemical": "Resin", "unit": "L", "initial_quantity": 20, "used_quantity": 0, "remaining_estimate": 10},
        ],
    }]

    assert server.chemical_low_stock_threshold(logs, "Resin", "kg", date(2026, 11, 3)) == 20
    assert server.chemical_low_stock_threshold(logs, "Resin", "L", date(2026, 11, 3)) == 4


def test_low_stock_alert_recipients_are_active_company_admins_and_owners():
    accounts = [
        {"id": "admin", "company_roles": {"company-a": "admin"}},
        {"id": "owner", "company_roles": {"company-a": "owner"}},
        {"id": "user", "company_roles": {"company-a": "user"}},
        {"id": "other-company-admin", "company_roles": {"company-b": "admin"}},
        {"id": "worker", "company_roles": {"company-a": "admin"}, "is_worker": True},
        {"id": "inactive", "company_roles": {"company-a": "admin"}, "active": False},
    ]

    recipients = server.fleet_notification_recipients(accounts, "company-a")

    assert {account["id"] for account in recipients} == {"admin", "owner"}
