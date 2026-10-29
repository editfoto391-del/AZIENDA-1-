from server import apply_stock_movements, profit_from_records


def test_stock_dashboard_summary_matches_stock_movement_rules():
    stock = {"id": "stock-1", "opening": 10}
    movements = [
        {"type": "purchase", "quantity": 3, "created_at": "2026-10-28T10:00:00+00:00"},
        {"type": "invoice", "quantity": 2, "created_at": "2026-10-29T10:00:00+00:00"},
        {"type": "adjustment_in", "quantity": 1.5, "direction": 1, "created_at": "2026-10-29T11:00:00+00:00"},
        {"type": "production_consumption", "quantity": 4, "created_at": "2026-10-29T12:00:00+00:00"},
    ]

    result = apply_stock_movements(stock, movements)

    assert result["current"] == 8.5
    assert result["purchased"] == 3
    assert result["production_used"] == 4
    assert result["invoiced"] == 2
    assert result["adjustments"] == 1.5
    assert result["last_movement"] == "2026-10-29T12:00:00+00:00"


def test_dashboard_profit_uses_same_period_filters_and_excludes_reversed_payments():
    result = profit_from_records(
        "2026-10-01",
        "2026-10-31",
        payments=[
            {"date": "2026-10-05", "amount": 100},
            {"date": "2026-10-10", "amount": 250, "reversed": True},
            {"date": "2026-11-01", "amount": 400},
        ],
        expenses=[
            {"date": "2026-10-07", "amount": 30},
            {"date": "2026-09-30", "amount": 80},
        ],
        vehicle_records=[
            {"date": "2026-10-08", "status": "Done", "amount": 20},
            {"date": "2026-10-09", "status": "Scheduled", "amount": 999},
        ],
        buyings=[
            {"date": "2026-10-12", "amount": 40},
            {"date": "2026-11-01", "amount": 60},
        ],
    )

    assert result["revenue"] == 100
    assert result["expenses"] == 50
    assert result["buyings"] == 40
    assert result["profit"] == 10
    assert result["label"].startswith("Estimated result")
