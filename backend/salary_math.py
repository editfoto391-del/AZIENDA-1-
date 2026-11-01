from datetime import date, datetime

STANDARD_WEEKLY_HOURS = 45
STANDARD_PAID_DAYS_PER_WEEK = 6
WEEKDAY_REGULAR_HOURS = 8
SATURDAY_REGULAR_HOURS = 5
OVERTIME_HOURLY_RATE = 20


def calculate_salary_hours(records):
    days = []

    for record in sorted(records, key=lambda item: item.get("date", "")):
        status = record.get("status")
        start_time = record.get("start_time")
        end_time = record.get("end_time")

        if status not in ("Present", "Half Day"):
            worked_hours = 0.0
            manual_overtime = 0.0
        elif start_time and end_time:
            start = datetime.strptime(start_time, "%H:%M")
            end = datetime.strptime(end_time, "%H:%M")
            worked_hours = ((end - start).total_seconds() / 3600) % 24
            weekday = date.fromisoformat(record["date"]).weekday()
            if weekday < 5 and worked_hours > WEEKDAY_REGULAR_HOURS:
                worked_hours = max(0, worked_hours - 1)
            manual_overtime = 0.0
        else:
            weekday = date.fromisoformat(record["date"]).weekday()
            default_full_day = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
            worked_hours = default_full_day if status == "Present" else default_full_day / 2
            manual_overtime = float(record.get("overtime_hours", 0) or 0)

        weekday = date.fromisoformat(record["date"]).weekday()
        scheduled_hours = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
        regular = min(worked_hours, scheduled_hours)
        overtime = max(0, worked_hours - scheduled_hours) + manual_overtime
        attendance_fraction = 1 if status == "Present" else 0.5 if status == "Half Day" else 0
        if scheduled_hours:
            attendance_fraction = min(attendance_fraction, regular / scheduled_hours)
        else:
            attendance_fraction = 0
        days.append({
            "date": record.get("date"),
            "status": status,
            "regular_hours": regular,
            "overtime_hours": overtime,
            "attendance_fraction": attendance_fraction,
        })

    return days
