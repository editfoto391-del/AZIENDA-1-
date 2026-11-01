def summarize_attendance_records(records, employees, week_start, month_start, today):
    daily = {}
    counts_by_employee = {}
    present_statuses = ("Present", "Half Day")

    for record in records:
        if record.get("date") == today:
            status = record["status"]
            daily[status] = daily.get(status, 0) + 1
        if record.get("status") not in present_statuses:
            continue

        employee_counts = counts_by_employee.setdefault(
            record.get("employee_id"), {"week": 0, "month": 0},
        )
        record_date = record.get("date") or ""
        if record_date >= week_start:
            employee_counts["week"] += 1
        if record_date >= month_start:
            employee_counts["month"] += 1

    per_employee = [
        {
            "employee_id": employee["id"],
            "name": employee["name"],
            "department": employee.get("department", ""),
            **counts_by_employee.get(employee["id"], {"week": 0, "month": 0}),
        }
        for employee in employees
    ]
    return {
        "daily": daily,
        "daily_total": sum(daily.values()),
        "week_total": sum(employee["week"] for employee in per_employee),
        "month_total": sum(employee["month"] for employee in per_employee),
        "per_employee": per_employee,
        "week_start": week_start,
        "month_start": month_start,
    }
