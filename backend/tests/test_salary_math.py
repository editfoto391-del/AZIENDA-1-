import asyncio
from datetime import date, timedelta

import server
from salary_math import calculate_salary_hours


def test_five_weekdays_make_40_regular_hours():
    monday = date(2026, 10, 26)
    records = [
        {"date": (monday + timedelta(days=day)).isoformat(), "status": "Present"}
        for day in range(5)
    ]

    result = calculate_salary_hours(records)

    assert sum(day["regular_hours"] for day in result) == 40
    assert sum(day["overtime_hours"] for day in result) == 0


def test_saturday_shift_is_five_regular_hours_even_after_full_weekdays():
    monday = date(2026, 10, 26)
    records = [
        {"date": (monday + timedelta(days=day)).isoformat(), "status": "Present"}
        for day in range(5)
    ]
    records.append({
        "date": (monday + timedelta(days=5)).isoformat(),
        "status": "Present",
        "start_time": "08:00",
        "end_time": "13:00",
    })

    result = calculate_salary_hours(records)

    assert sum(day["regular_hours"] for day in result) == 45
    assert sum(day["overtime_hours"] for day in result) == 0


def test_hours_beyond_each_days_standard_shift_are_overtime():
    result = calculate_salary_hours([{
        "date": "2026-10-26",
        "status": "Present",
        "start_time": "08:00",
        "end_time": "19:00",
    }])

    assert result[0]["regular_hours"] == 8
    assert result[0]["overtime_hours"] == 2


def test_standard_weekday_shift_excludes_one_hour_lunch_break():
    result = calculate_salary_hours([{
        "date": "2026-10-26",
        "status": "Present",
        "start_time": "08:00",
        "end_time": "17:00",
    }])

    assert result[0]["regular_hours"] == 8
    assert result[0]["overtime_hours"] == 0


def test_short_custom_shift_earns_pay_proportional_to_regular_hours():
    result = calculate_salary_hours([{
        "date": "2026-10-26",
        "status": "Present",
        "start_time": "08:00",
        "end_time": "12:00",
    }])

    assert result[0]["regular_hours"] == 4
    assert result[0]["attendance_fraction"] == 0.5


def test_saved_times_are_used_instead_of_default_hours_or_manual_overtime():
    result = calculate_salary_hours([{
        "date": "2026-10-26",
        "status": "Present",
        "start_time": "08:00",
        "end_time": "13:00",
        "overtime_hours": 2,
    }])

    assert result[0]["regular_hours"] == 5
    assert result[0]["overtime_hours"] == 0


def test_half_day_without_times_defaults_to_four_hours():
    result = calculate_salary_hours([{"date": "2026-10-26", "status": "Half Day"}])

    assert result[0]["regular_hours"] == 4
    assert result[0]["overtime_hours"] == 0


def test_saturday_without_times_defaults_to_five_hours():
    result = calculate_salary_hours([{"date": "2026-10-31", "status": "Present"}])

    assert result[0]["regular_hours"] == 5
    assert result[0]["overtime_hours"] == 0


def test_six_day_schedule_totals_45_regular_hours():
    monday = date(2026, 10, 26)
    records = [
        {"date": (monday + timedelta(days=day)).isoformat(), "status": "Present"}
        for day in range(6)
    ]

    result = calculate_salary_hours(records)

    assert sum(day["regular_hours"] for day in result) == 45
    assert sum(day["overtime_hours"] for day in result) == 0


def test_salary_report_prorates_fixed_salary_and_pays_overtime_at_twenty_rand(monkeypatch):
    employee = {
        "id": "employee-1",
        "name": "Worker",
        "weekly_salary": 1000,
        "hourly_rate": 20,
        "hours_per_week": 45,
        "work_days_per_week": 5,
    }
    attendance = [
        {
            "employee_id": "employee-1", "date": "2026-10-26", "status": "Present",
            "start_time": "08:00", "end_time": "19:00",
        },
        {
            "employee_id": "employee-1", "date": "2026-10-27", "status": "Half Day",
            "overtime_hours": 1,
        },
        {"employee_id": "employee-1", "date": "2026-10-28", "status": "Absent"},
        {
            "employee_id": "employee-1", "date": "2026-10-31", "status": "Present",
            "start_time": "08:00", "end_time": "15:00",
        },
    ]
    records = {
        "employees": [employee],
        "attendance": attendance,
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-10-26", "2026-11-01"))
    result = report["employees"][0]

    assert result["present_days"] == 2
    assert result["half_days"] == 1
    assert result["regular_hours"] == 17
    assert result["regular_pay"] == 416.67
    assert result["overtime_hours"] == 5
    assert result["overtime_pay"] == 100
    assert result["gross_salary"] == 516.67
    assert result["work_days_per_week"] == 6
    assert result["hours_per_week"] == 45
    assert [day["pay"] for day in result["days"]] == [206.67, 103.33, 0, 206.67]


def test_full_six_day_attendance_earns_the_fixed_weekly_salary(monkeypatch):
    employee = {
        "id": "employee-1",
        "name": "Anele Fabric",
        "weekly_salary": 1000,
        "hours_per_week": 45,
    }
    monday = date(2026, 10, 26)
    records = {
        "employees": [employee],
        "attendance": [
            {
                "employee_id": "employee-1",
                "date": (monday + timedelta(days=offset)).isoformat(),
                "status": "Present",
            }
            for offset in range(6)
        ],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-10-26", "2026-11-01"))
    result = report["employees"][0]

    assert result["regular_hours"] == 45
    assert result["regular_pay"] == 1000
    assert result["overtime_hours"] == 0
    assert result["gross_salary"] == 1000


def test_five_weekdays_earn_five_sixths_of_fixed_weekly_salary(monkeypatch):
    employee = {
        "id": "employee-1",
        "name": "Anele Fabric",
        "weekly_salary": 1000,
        "hours_per_week": 45,
    }
    monday = date(2026, 10, 26)
    records = {
        "employees": [employee],
        "attendance": [
            {
                "employee_id": "employee-1",
                "date": (monday + timedelta(days=offset)).isoformat(),
                "status": "Present",
            }
            for offset in range(5)
        ],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-10-26", "2026-11-01"))
    result = report["employees"][0]

    assert result["regular_hours"] == 40
    assert result["regular_pay"] == 833.33
    assert result["gross_salary"] == 833.33


def test_monthly_fixed_employees_are_recognized_by_name():
    assert server.is_monthly_fixed_salary_employee({"name": "MR. YASEEN"})
    assert server.is_monthly_fixed_salary_employee({"name": "Yassine Uncle"})
    assert server.is_monthly_fixed_salary_employee({"name": "AMEENA"})
    assert server.is_monthly_fixed_salary_employee({"name": "Amina"})
    assert not server.is_monthly_fixed_salary_employee({"name": "Yaseen"})


def test_monthly_fixed_salary_is_paid_once_for_a_complete_month(monkeypatch):
    employee = {
        "id": "employee-monthly",
        "name": "MR. YASEEN",
        "monthly_salary": 12000,
        "weekly_salary": 1000,
    }
    records = {
        "employees": [employee],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-10-01", "2026-10-31"))
    result = report["employees"][0]

    assert result["pay_frequency"] == "monthly_fixed"
    assert result["monthly_salary"] == 12000
    assert result["gross_salary"] == 12000
    assert result["regular_pay"] == 0
    assert result["overtime_pay"] == 0


def test_monthly_fixed_salary_is_not_repeated_in_a_partial_month(monkeypatch):
    records = {
        "employees": [{"id": "employee-monthly", "name": "AMEENA", "monthly_salary": 9000}],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-10-26", "2026-11-01"))

    assert report["employees"][0]["gross_salary"] == 0
    assert report["employees"][0]["is_full_month_period"] is False


def test_monthly_fixed_salary_can_be_explicitly_included_in_a_weekly_report(monkeypatch):
    employee = {
        "id": "employee-yaseen",
        "name": "Yassine Uncle",
        "monthly_salary": 18000,
    }
    records = {
        "employees": [employee],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [{
            "employee_id": employee["id"],
            "date": "2026-10-31",
            "amount": 1200,
        }],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report(
        "2026-11-02",
        "2026-11-07",
        include_monthly_salaries=True,
    ))
    result = report["employees"][0]

    assert result["pay_frequency"] == "monthly_fixed"
    assert result["monthly_salary"] == 18000
    assert result["gross_salary"] == 18000
    assert result["cut"] == 0
    assert result["net_salary"] == 18000
    assert result["balance_before_period"] == 1200
    assert result["balance_after_period"] == 1200
    assert result["is_full_month_period"] is False


def test_salary_payroll_keys_are_unique_by_week_or_calendar_month():
    assert server.salary_payroll_key("weekly", "2026-11-02", "2026-11-07") == "weekly:2026-11-02"
    assert server.salary_payroll_key("monthly", "2026-11-01", "2026-11-30") == "monthly:2026-11"


def test_yaseen_uncle_november_salary_does_not_apply_an_automatic_balance_deduction(monkeypatch):
    employee = {
        "id": "employee-yaseen",
        "name": "Yassine Uncle",
        "monthly_salary": 18000,
        "weekly_salary": 1200,
    }
    records = {
        "employees": [employee],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [{
            "employee_id": employee["id"],
            "date": "2026-10-31",
            "amount": 1200,
        }],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-11-01", "2026-11-30"))
    result = report["employees"][0]

    assert result["pay_frequency"] == "monthly_fixed"
    assert result["monthly_salary"] == 18000
    assert result["gross_salary"] == 18000
    assert result["cut"] == 0
    assert result["net_salary"] == 18000
    assert result["balance_before_period"] == 1200
    assert result["balance_after_period"] == 1200


def test_yaseen_uncle_monthly_report_uses_only_the_manual_balance_deduction(monkeypatch):
    employee = {"id": "employee-yaseen", "name": "Yaseen Uncle", "monthly_salary": 18000}
    records = {
        "employees": [employee],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [{"employee_id": employee["id"], "date": "2026-10-31", "amount": 1200}],
        "salary_cuts": [{
            "employee_id": employee["id"], "start_date": "2026-11-02", "end_date": "2026-11-07",
            "amount": 400,
        }],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    result = asyncio.run(server.salary_report("2026-11-01", "2026-11-30"))["employees"][0]

    assert result["monthly_salary"] == 18000
    assert result["cut"] == 400
    assert result["net_salary"] == 17600
    assert result["balance_after_period"] == 800


def test_yaseen_uncle_is_not_paid_monthly_in_a_partial_november_period(monkeypatch):
    employee = {"id": "employee-yaseen", "name": "Yaseen Uncle", "monthly_salary": 18000}
    records = {
        "employees": [employee],
        "attendance": [],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    result = asyncio.run(server.salary_report("2026-11-02", "2026-11-07"))["employees"][0]

    assert result["pay_frequency"] == "monthly_fixed"
    assert result["monthly_salary"] == 18000
    assert result["gross_salary"] == 0
    assert result["cut"] == 0


def test_salary_report_sums_duplicate_cuts_for_the_selected_period(monkeypatch):
    employee = {"id": "employee-1", "name": "Worker", "weekly_salary": 600}
    period_cuts = [
        {"employee_id": employee["id"], "start_date": "2026-11-02", "end_date": "2026-11-07", "amount": amount}
        for amount in (100, 200)
    ]
    records = {
        "employees": [employee],
        "attendance": [{
            "employee_id": employee["id"], "date": (date(2026, 11, 2) + timedelta(days=offset)).isoformat(),
            "status": "Present",
        } for offset in range(6)],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": period_cuts,
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    first = asyncio.run(server.salary_report("2026-11-02", "2026-11-07"))["employees"][0]
    second = asyncio.run(server.salary_report("2026-11-02", "2026-11-07"))["employees"][0]

    assert first["cut"] == second["cut"] == 300


def test_missing_monthly_salary_is_not_replaced_by_a_weekly_default_and_unmatched_attendance_is_reported(monkeypatch):
    employee = {
        "id": "employee-yassine",
        "name": "Yassine Uncle",
        "weekly_salary": 5300,
    }
    records = {
        "employees": [employee],
        "attendance": [{
            "employee_id": "missing-employee",
            "employee_name": "Unmatched worker",
            "date": "2026-11-03",
            "status": "Present",
        }],
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    report = asyncio.run(server.salary_report("2026-11-02", "2026-11-07", include_monthly_salaries=True))

    assert report["employees"][0]["pay_frequency"] == "monthly_fixed"
    assert report["employees"][0]["gross_salary"] == 0
    assert report["employees"][0]["salary_rate_missing"] is True
    assert report["unmatched_attendance_records"] == [{
        "employee_id": "missing-employee",
        "employee_name": "Unmatched worker",
        "date": "2026-11-03",
        "status": "Present",
    }]


def test_monthly_report_includes_manual_cuts_from_each_weekly_payroll(monkeypatch):
    employee = {"id": "employee-weekly", "name": "Worker", "weekly_salary": 600}
    attendance = [
        {
            "employee_id": employee["id"],
            "date": (date(2026, 11, 2) + timedelta(days=week * 7 + day)).isoformat(),
            "status": "Present",
        }
        for week in range(2)
        for day in range(6)
    ]
    records = {
        "employees": [employee],
        "attendance": attendance,
        "piece_production": [],
        "salary_advances": [],
        "salary_cuts": [
            {"employee_id": employee["id"], "start_date": "2026-11-02", "end_date": "2026-11-07", "amount": 100},
            {"employee_id": employee["id"], "start_date": "2026-11-09", "end_date": "2026-11-14", "amount": 200},
        ],
    }

    async def fake_listall(collection, *_args, **_kwargs):
        return records[collection]

    monkeypatch.setattr(server, "listall", fake_listall)

    result = asyncio.run(server.salary_report("2026-11-01", "2026-11-30"))["employees"][0]

    assert result["gross_salary"] == 1200
    assert result["cut"] == 300
    assert result["net_salary"] == 900
