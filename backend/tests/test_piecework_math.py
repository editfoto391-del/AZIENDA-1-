from piecework_math import calculate_piecework


def weekly_result(*daily_counts):
    dates = [
        "2026-10-26", "2026-10-27", "2026-10-28",
        "2026-10-29", "2026-10-30", "2026-10-31",
    ]
    return calculate_piecework([
        {"date": work_date, "pieces": pieces}
        for work_date, pieces in zip(dates, daily_counts)
    ], include_sunday=False)


def test_saturday_at_40_pays_all_pieces_at_the_high_rate():
    result = weekly_result(70, 70, 70, 70, 70, 40)

    week = result["weeks"][0]
    assert week["pieces"] == 390
    assert week["high_rate_pieces"] == 390
    assert week["low_rate_pieces"] == 0
    assert week["saturday_high_rate_pieces"] == 40
    assert week["unpaid_saturday_pieces"] == 0
    assert week["saturday_rate"] == 3.5
    assert week["saturday_pay"] == 140
    assert week["saturday_bonus"] == 0
    assert week["unrecovered_weekday_deficit"] == 0
    assert result["piece_pay"] == 1365


def test_ayanda_weekly_piece_pay_includes_saturday_piece_rate():
    result = weekly_result(49, 70, 70, 70, 72, 40)

    assert result["piece_pay"] == 1279.5
    assert result["weeks"][0]["saturday_pay"] == 140
    assert result["weeks"][0]["unpaid_saturday_pieces"] == 0


def test_asive_weekly_piece_pay_includes_saturday_piece_rate():
    result = weekly_result(55, 72, 70, 70, 70, 41)

    assert result["piece_pay"] == 1311
    assert result["weeks"][0]["saturday_high_rate_pieces"] == 41
    assert result["weeks"][0]["saturday_bonus"] == 0


def test_weekday_surplus_recovers_monday_deficit():
    result = weekly_result(60, 80)

    week = result["weeks"][0]
    assert week["weekday_recovery_pieces"] == 10
    assert week["total_surplus_pieces"] == 10
    assert week["unused_surplus_pieces"] == 0
    assert week["weekday_high_rate_pieces"] == 140
    assert week["weekday_low_rate_pieces"] == 0
    assert [day["recovered_previous_deficits"] for day in week["days"][:2]] == [0, 10]
    assert result["piece_pay"] == 490


def test_weekday_recovery_is_oldest_first_and_applies_across_days():
    result = weekly_result(50, 75, 85)

    week = result["weeks"][0]
    assert week["weekday_recovery_pieces"] == 20
    assert week["weekday_high_rate_pieces"] == 210
    assert week["weekday_low_rate_pieces"] == 0
    assert week["unrecovered_weekday_deficit"] == 0
    assert result["piece_pay"] == 735


def test_saturday_first_40_pieces_cannot_recover_weekday_deficit():
    result = weekly_result(55, 70, 70, 70, 70, 40)

    week = result["weeks"][0]
    assert week["saturday_rate"] == 3.5
    assert week["saturday_pay"] == 140
    assert week["saturday_bonus"] == 0
    assert week["saturday_recovery_pieces"] == 0
    assert week["unrecovered_weekday_deficit"] == 15
    assert week["weekday_low_rate_pieces"] == 15
    assert result["piece_pay"] == 1297.5


def test_only_saturday_pieces_above_40_recover_weekday_deficits():
    result = weekly_result(55, 70, 70, 70, 70, 50)

    week = result["weeks"][0]
    assert week["saturday_surplus_pieces"] == 10
    assert week["saturday_recovery_pieces"] == 10
    assert week["unrecovered_weekday_deficit"] == 5
    assert week["weekday_low_rate_pieces"] == 5
    assert week["high_rate_pieces"] + week["low_rate_pieces"] + week["unpaid_saturday_pieces"] == week["pieces"]
    assert week["saturday_bonus"] == 0
    assert week["saturday_pay"] == 175
    assert result["piece_pay"] == 1342.5


def test_saturday_surplus_recovers_entire_remaining_weekday_deficit():
    result = weekly_result(55, 70, 70, 70, 70, 60)

    week = result["weeks"][0]
    assert week["saturday_recovery_pieces"] == 15
    assert week["unrecovered_weekday_deficit"] == 0
    assert week["weekday_low_rate_pieces"] == 0
    assert week["saturday_bonus"] == 0
    assert week["saturday_pay"] == 210
    assert result["piece_pay"] == 1382.5


def test_saturday_below_40_pays_each_piece_at_low_rate():
    result = weekly_result(0, 0, 0, 0, 0, 39)

    week = result["weeks"][0]
    assert week["saturday_rate"] == 2.5
    assert week["saturday_pay"] == 97.5
    assert week["saturday_low_rate_pieces"] == 39
    assert week["saturday_recovery_pieces"] == 0


def test_saturday_at_and_above_40_pays_each_piece_at_high_rate():
    at_target = weekly_result(0, 0, 0, 0, 0, 40)["weeks"][0]
    above_target = weekly_result(0, 0, 0, 0, 0, 41)["weeks"][0]

    assert (at_target["saturday_rate"], at_target["saturday_pay"]) == (3.5, 140)
    assert (above_target["saturday_rate"], above_target["saturday_pay"]) == (3.5, 143.5)


def test_editing_monday_recalculates_all_recovery_and_pay_results():
    initial = calculate_piecework([
        {"date": "2026-10-26", "pieces": 60},
        {"date": "2026-10-27", "pieces": 80},
    ], include_sunday=False)
    edited = calculate_piecework([
        {"date": "2026-10-26", "pieces": 50},
        {"date": "2026-10-27", "pieces": 80},
    ], include_sunday=False)

    assert initial["weeks"][0]["weekday_low_rate_pieces"] == 0
    assert initial["weeks"][0]["pay"] == 490
    assert edited["weeks"][0]["weekday_low_rate_pieces"] == 10
    assert edited["weeks"][0]["unrecovered_weekday_deficit"] == 10
    assert edited["weeks"][0]["pay"] == 445


def test_employees_calculate_independently_and_every_piece_is_counted_once():
    ayanda = calculate_piecework([
        {"date": "2026-10-26", "pieces": 60},
        {"date": "2026-10-27", "pieces": 80},
    ], include_sunday=False)
    asive = calculate_piecework([
        {"date": "2026-10-26", "pieces": 50},
        {"date": "2026-10-27", "pieces": 70},
    ], include_sunday=False)

    assert ayanda["total_pieces"] == 140
    assert ayanda["piece_pay"] == 490
    assert asive["total_pieces"] == 120
    assert asive["piece_pay"] == 400
    for result in (ayanda, asive):
        week = result["weeks"][0]
        assert week["high_rate_pieces"] + week["low_rate_pieces"] == week["pieces"]


def test_sunday_is_excluded_for_target_employees_but_preserved_for_existing_piecework():
    records = [
        {"date": "2026-10-26", "pieces": 60},
        {"date": "2026-11-01", "pieces": 20},
    ]

    target_employee = calculate_piecework(records, include_sunday=False)
    other_piece_employee = calculate_piecework(records)

    assert target_employee["total_pieces"] == 60
    assert target_employee["piece_pay"] == 200
    assert other_piece_employee["total_pieces"] == 80
    assert other_piece_employee["piece_pay"] == 250


def test_weekly_dashboard_contains_all_six_days_even_when_no_production_is_recorded():
    result = calculate_piecework([], include_sunday=False, start_date="2026-10-26", end_date="2026-11-01")

    week = result["weeks"][0]
    assert week["week_start"] == "2026-10-26"
    assert week["week_end"] == "2026-10-31"
    assert [day["pieces"] for day in week["days"]] == [0, 0, 0, 0, 0, 0]
