from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP


PIECEWORK_THRESHOLD = 70
DAILY_PIECEWORK_TARGET = 55
SATURDAY_PIECEWORK_THRESHOLD = 40
PIECEWORK_LOW_RATE = Decimal("2.50")
PIECEWORK_HIGH_RATE = Decimal("3.50")


def _money(amount):
    return float(amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def calculate_piecework(
    records, *, include_sunday=True, start_date=None, end_date=None,
    daily_rate_tiers=False,
):
    daily_pieces = {}
    recorded_dates = set()
    week_starts = set()
    for record in records:
        work_date = date.fromisoformat(record["date"])
        week_start = work_date - timedelta(days=work_date.weekday())
        week_starts.add(week_start)
        recorded_dates.add(work_date)
        daily_pieces[work_date] = daily_pieces.get(work_date, 0) + int(record.get("pieces", 0))

    if start_date and end_date:
        first = date.fromisoformat(start_date)
        last = date.fromisoformat(end_date)
        week_start = first - timedelta(days=first.weekday())
        while week_start <= last:
            week_starts.add(week_start)
            week_start += timedelta(days=7)

    daily = []
    weeks = []
    total_pieces = 0
    total_pay = Decimal("0")
    for week_start in sorted(week_starts):
        weekday_rows = []
        outstanding = []
        weekday_surplus = 0
        weekday_recovered = 0
        weekday_pieces = 0

        for day_offset in range(5):
            work_date = week_start + timedelta(days=day_offset)
            pieces = daily_pieces.get(work_date, 0)
            recorded = work_date in recorded_dates
            weekday_pieces += pieces
            target = DAILY_PIECEWORK_TARGET if daily_rate_tiers else PIECEWORK_THRESHOLD
            deficit = max(0, target - pieces) if recorded else 0
            surplus = max(0, pieces - target) if recorded else 0
            weekday_surplus += surplus
            own_deficit = {"date": work_date, "remaining": deficit}
            if deficit and not daily_rate_tiers:
                outstanding.append(own_deficit)

            recovered = 0
            remaining_surplus = surplus
            for earlier_deficit in outstanding:
                if earlier_deficit is own_deficit or remaining_surplus == 0:
                    continue
                used = min(earlier_deficit["remaining"], remaining_surplus)
                earlier_deficit["remaining"] -= used
                remaining_surplus -= used
                recovered += used
            weekday_recovered += recovered
            weekday_rows.append({
                "date": work_date.isoformat(),
                "pieces": pieces,
                "recorded": recorded,
                "target": target,
                **({"high_rate_target": PIECEWORK_THRESHOLD} if daily_rate_tiers else {}),
                "surplus": surplus,
                "deficit": deficit,
                "recovered_previous_deficits": recovered,
                "unrecovered_deficit": own_deficit,
            })

        saturday = week_start + timedelta(days=5)
        saturday_pieces = daily_pieces.get(saturday, 0)
        saturday_recorded = saturday in recorded_dates
        saturday_surplus = max(0, saturday_pieces - SATURDAY_PIECEWORK_THRESHOLD) if saturday_recorded else 0
        saturday_recovered = 0
        remaining_surplus = saturday_surplus
        for earlier_deficit in outstanding:
            if remaining_surplus == 0:
                break
            used = min(earlier_deficit["remaining"], remaining_surplus)
            earlier_deficit["remaining"] -= used
            remaining_surplus -= used
            saturday_recovered += used

        weekday_high_pieces = 0
        weekday_low_pieces = 0
        weekday_pay = Decimal("0")
        for row in weekday_rows:
            if daily_rate_tiers:
                low_pieces = row["pieces"] if row["pieces"] < PIECEWORK_THRESHOLD else 0
                row["unrecovered_deficit"] = row["deficit"]
            else:
                low_pieces = min(row["pieces"], row["unrecovered_deficit"]["remaining"])
                row["unrecovered_deficit"] = row["unrecovered_deficit"]["remaining"]
            high_pieces = row["pieces"] - low_pieces
            row["high_rate_pieces"] = high_pieces
            row["low_rate_pieces"] = low_pieces
            row["piece_rate"] = float(
                PIECEWORK_HIGH_RATE if high_pieces else PIECEWORK_LOW_RATE
            )
            row["high_rate_pay"] = _money(Decimal(high_pieces) * PIECEWORK_HIGH_RATE)
            row["low_rate_pay"] = _money(Decimal(low_pieces) * PIECEWORK_LOW_RATE)
            row["pay"] = _money(
                Decimal(high_pieces) * PIECEWORK_HIGH_RATE
                + Decimal(low_pieces) * PIECEWORK_LOW_RATE
            )
            weekday_high_pieces += high_pieces
            weekday_low_pieces += low_pieces
            weekday_pay += Decimal(str(row["pay"]))
            daily.append(row)

        saturday_rate = (
            PIECEWORK_LOW_RATE
            if daily_rate_tiers
            else PIECEWORK_HIGH_RATE
            if saturday_recorded and saturday_pieces >= SATURDAY_PIECEWORK_THRESHOLD
            else PIECEWORK_LOW_RATE
        )
        saturday_high_pieces = (
            0 if daily_rate_tiers
            else saturday_pieces
            if saturday_recorded and saturday_pieces >= SATURDAY_PIECEWORK_THRESHOLD
            else 0
        )
        saturday_low_pieces = (
            saturday_pieces
            if daily_rate_tiers or saturday_recorded and saturday_pieces < SATURDAY_PIECEWORK_THRESHOLD
            else 0
        )
        saturday_pay = Decimal(saturday_high_pieces) * PIECEWORK_HIGH_RATE + Decimal(saturday_low_pieces) * PIECEWORK_LOW_RATE
        daily.append({
            "date": saturday.isoformat(),
            "pieces": saturday_pieces,
            "recorded": saturday_recorded,
            "target": SATURDAY_PIECEWORK_THRESHOLD,
            "surplus": saturday_surplus,
            "deficit": max(0, SATURDAY_PIECEWORK_THRESHOLD - saturday_pieces) if saturday_recorded else 0,
            "recovered_previous_deficits": saturday_recovered,
            "unrecovered_deficit": 0,
            "high_rate_pieces": saturday_high_pieces,
            "low_rate_pieces": saturday_low_pieces,
            "high_rate_pay": _money(Decimal(saturday_high_pieces) * PIECEWORK_HIGH_RATE),
            "low_rate_pay": _money(Decimal(saturday_low_pieces) * PIECEWORK_LOW_RATE),
            "piece_rate": float(saturday_rate),
            "pay": _money(saturday_pay),
        })

        unrecovered = sum(item["remaining"] for item in outstanding)
        recovered_total = weekday_recovered + saturday_recovered
        pieces = weekday_pieces + saturday_pieces
        week_pay = weekday_pay + saturday_pay
        total_high_pieces = weekday_high_pieces + saturday_high_pieces
        total_low_pieces = weekday_low_pieces + saturday_low_pieces
        week_details = {
            "week_start": week_start.isoformat(),
            "week_end": saturday.isoformat(),
            "days": weekday_rows + [daily[-1]],
            "pieces": pieces,
            "weekday_pieces": weekday_pieces,
            "saturday_pieces": saturday_pieces,
            "weekday_deficit_pieces": sum(row["deficit"] for row in weekday_rows),
            "total_surplus_pieces": weekday_surplus + saturday_surplus,
            "unused_surplus_pieces": weekday_surplus + saturday_surplus - recovered_total,
            "weekday_surplus_pieces": weekday_surplus,
            "saturday_surplus_pieces": saturday_surplus,
            "weekday_recovery_pieces": weekday_recovered,
            "saturday_recovery_pieces": saturday_recovered,
            "recovered_pieces": recovered_total,
            "unrecovered_weekday_deficit": unrecovered,
            "weekday_high_rate_pieces": weekday_high_pieces,
            "weekday_low_rate_pieces": weekday_low_pieces,
            "high_rate_pieces": total_high_pieces,
            "low_rate_pieces": total_low_pieces,
            "saturday_high_rate_pieces": saturday_high_pieces,
            "saturday_low_rate_pieces": saturday_low_pieces,
            "unpaid_saturday_pieces": 0,
            "weekday_pay": _money(weekday_pay),
            "saturday_rate": float(saturday_rate),
            "saturday_bonus": 0,
            "saturday_pay": _money(saturday_pay),
            "other_pieces": 0,
            "other_pay": 0,
            "pay": _money(week_pay),
        }

        other_pieces = 0
        other_pay = Decimal("0")
        if include_sunday:
            sunday = week_start + timedelta(days=6)
            other_pieces = daily_pieces.get(sunday, 0)
            other_pay = Decimal(other_pieces) * PIECEWORK_LOW_RATE
            if other_pieces:
                daily.append({
                    "date": sunday.isoformat(),
                    "pieces": other_pieces,
                    "recorded": True,
                    "target": 0,
                    "surplus": 0,
                    "deficit": 0,
                    "recovered_previous_deficits": 0,
                    "unrecovered_deficit": 0,
                    "high_rate_pieces": 0,
                    "low_rate_pieces": other_pieces,
                    "high_rate_pay": 0,
                    "low_rate_pay": _money(other_pay),
                    "piece_rate": float(PIECEWORK_LOW_RATE),
                    "pay": _money(other_pay),
                })
            week_details["other_pieces"] = other_pieces
            week_details["other_pay"] = _money(other_pay)
            week_details["pieces"] += other_pieces
            week_details["low_rate_pieces"] += other_pieces
            week_details["pay"] = _money(week_pay + other_pay)

        weeks.append(week_details)
        total_pieces += week_details["pieces"]
        total_pay += Decimal(str(week_details["pay"]))

    daily.sort(key=lambda item: item["date"])
    return {
        "days": daily,
        "total_pieces": total_pieces,
        "piece_rate": daily[-1].get("piece_rate", float(PIECEWORK_LOW_RATE)) if daily else float(PIECEWORK_LOW_RATE),
        "piece_pay": _money(total_pay),
        "weeks": weeks,
    }
