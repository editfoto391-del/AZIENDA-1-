from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

STANDARD_WEEKLY_HOURS = 45
STANDARD_PAID_DAYS_PER_WEEK = 6
WEEKDAY_REGULAR_HOURS = 8
SATURDAY_REGULAR_HOURS = 6
OVERTIME_HOURLY_RATE = 20
OVERTIME_AFTER_17_HOURLY_RATE = 21

PIECEWORK_LOW_RATE = Decimal("2.50")
PIECEWORK_HIGH_RATE = Decimal("3.50")


def d(value):
    return Decimal(str(value if value is not None else "0"))


def money(value):
    return d(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calculate_attendance(attendance_values, half_day_hours=5):
    full_day_hours = 8
    worked_hours = Decimal("0")
    worked_days = Decimal("0")
    for value in attendance_values:
        if value is None or value == "" or value == 0:
            continue
        if isinstance(value, str) and value.lower() == "x":
            worked_hours += Decimal(full_day_hours)
            worked_days += Decimal("1")
        elif isinstance(value, (int, float, Decimal)):
            quantity = d(value)
            if quantity == 1:
                worked_hours += Decimal(full_day_hours)
                worked_days += Decimal("1")
            elif quantity == Decimal("0.5"):
                worked_hours += d(half_day_hours)
                worked_days += Decimal("0.5")
            elif quantity < 0:
                raise ValueError("Attendance values cannot be negative")
            else:
                raise ValueError("Invalid attendance value")
        else:
            raise ValueError("Invalid attendance value")
    return {
        "worked_hours": float(worked_hours),
        "worked_days": float(worked_days),
        "half_day_hours": float(d(half_day_hours)),
    }


def calculate_standard_salary(weekly_salary, worked_hours, overtime_amount=0, divisor=48):
    base = d(weekly_salary) / d(divisor) * d(worked_hours)
    gross = money(base + d(overtime_amount))
    return float(gross)


def calculate_overtime(overtime_hours, overtime_rate):
    return float(money(d(overtime_hours) * d(overtime_rate)))


def calculate_piecework_formula(daily_quantities, formula="A", overtime_amount=0,
                                high_rate=PIECEWORK_HIGH_RATE, low_rate=PIECEWORK_LOW_RATE):
    quantities = [d(value or 0) for value in daily_quantities]
    while len(quantities) < 7:
        quantities.append(Decimal("0"))
    n, o, p, q, r, s = quantities[:6]

    ranges = {
        "A": ((o + p, high_rate), (n, low_rate), (q, low_rate), (r, high_rate), (s, low_rate)),
        "B": ((o + p, high_rate), (n, high_rate), (q, high_rate), (r, high_rate), (s, low_rate)),
        "C": ((o + p, high_rate), (n, low_rate), (q, high_rate), (r, high_rate), (s, low_rate)),
        "D": ((n + o + p, high_rate), (o, low_rate), (q, high_rate), (r, high_rate), (s, low_rate)),
        "E": ((o + p + q, high_rate), (r, low_rate), (n, low_rate), (s, low_rate)),
        "F": ((p + q, high_rate), (r, low_rate), (n, low_rate), (o, low_rate), (s, low_rate)),
        "G": ((n + o + p, high_rate), (q, low_rate), (r, high_rate), (s, low_rate)),
        "H": ((n + o + p + q + r, high_rate), (s, low_rate)),
        "I": ((o + p + q + r, high_rate), (n, low_rate), (s, low_rate)),
        "J": ((o + p, high_rate), (r, low_rate), (n, low_rate), (s, low_rate)),
        "K": ((p + q, high_rate), (r, low_rate), (n, low_rate), (o, low_rate), (s, low_rate)),
        "L": ((n + o + p, high_rate), (q, low_rate), (r, high_rate), (s, low_rate)),
        "M": ((n + o + p + q + r, high_rate), (s, low_rate)),
        "N": ((o + p + q + r, high_rate), (n, low_rate), (s, low_rate)),
    }
    key = str(formula).strip().upper()
    if key not in ranges:
        raise ValueError("Unknown piecework formula")
    pieces_pay = sum((quantity * d(rate) for quantity, rate in ranges[key]), Decimal("0"))
    gross = money(pieces_pay + d(overtime_amount))
    return {"piece_pay": float(money(pieces_pay)), "overtime_amount": float(money(d(overtime_amount))), "gross": float(gross)}


def calculate_salary_hours(records, *, half_day_hours=5):
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
            manual_overtime = float(record.get("overtime_hours") or 0)
            if manual_overtime:
                overtime_after_17 = 0.0
        else:
            weekday = date.fromisoformat(record["date"]).weekday()
            default_full_day = WEEKDAY_REGULAR_HOURS if weekday < 6 else 0
            worked_hours = default_full_day if status == "Present" else float(half_day_hours) if status == "Half Day" else 0
            manual_overtime = float(record.get("overtime_hours") or 0)
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
            "salary_overtime_override": record.get("salary_overtime_override"),
            "salary_overtime_rate_override": record.get("salary_overtime_rate_override"),
        })

    return days
