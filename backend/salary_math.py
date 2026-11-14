from datetime import date, datetime

STANDARD_WEEKLY_HOURS = 45
STANDARD_PAID_DAYS_PER_WEEK = 6
WEEKDAY_REGULAR_HOURS = 8
SATURDAY_REGULAR_HOURS = 6
OVERTIME_HOURLY_RATE = 20
OVERTIME_AFTER_17_HOURLY_RATE = 21


def calculate_salary_hours(records):
    days = []

    for record in sorted(records, key=lambda item: item.get("date", "")):
        status = record.get("status")
        start_time = record.get("start_time")
        end_time = record.get("end_time")
        overtime_after_17 = 0.0

        if status not in ("Present", "Half Day"):
            worked_hours = 0.0
            manual_overtime = 0.0
        elif start_time and end_time:
            start = datetime.strptime(start_time, "%H:%M")
            end = datetime.strptime(end_time, "%H:%M")
            elapsed_hours = ((end - start).total_seconds() / 3600) % 24
            weekday = date.fromisoformat(record["date"]).weekday()
            worked_hours = (
                max(0, elapsed_hours - 1)
                if weekday < 5 and elapsed_hours > WEEKDAY_REGULAR_HOURS
                else elapsed_hours
            )
            end_minutes = end.hour * 60 + end.minute
            overtime_after_17 = max(0, (end_minutes - 17 * 60) / 60)
            manual_overtime = 0.0
        else:
            weekday = date.fromisoformat(record["date"]).weekday()
            default_full_day = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
            worked_hours = default_full_day if status == "Present" else default_full_day / 2
            manual_overtime = 0.0
            overtime_after_17 = 0.0

        weekday = date.fromisoformat(record["date"]).weekday()
        scheduled_hours = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
        worked_hours = max(0, worked_hours)
        regular = max(0, worked_hours - overtime_after_17)
        overtime = overtime_after_17 + manual_overtime
        attendance_fraction = 1 if status == "Present" else 0.5 if status == "Half Day" else 0
        if scheduled_hours:
            attendance_fraction = min(attendance_fraction, min(regular, scheduled_hours) / scheduled_hours)
        else:
            attendance_fraction = 0
        days.append({
            "date": record.get("date"),
            "status": status,
            "worked_hours": worked_hours,
            "regular_hours": regular,
            "overtime_hours": overtime,
            "overtime_after_17_hours": min(overtime, overtime_after_17),
            "attendance_fraction": attendance_fraction,
        })

    return days
