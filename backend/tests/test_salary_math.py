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
