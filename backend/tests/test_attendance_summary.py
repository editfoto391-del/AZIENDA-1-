import unittest

from attendance_math import summarize_attendance_records


class AttendanceSummaryTests(unittest.TestCase):
    def test_single_pass_summary_matches_previous_per_employee_counts(self):
        records = [
            {"employee_id": "active-a", "date": "2026-11-01", "status": "Present"},
            {"employee_id": "active-a", "date": "2026-10-28", "status": "Half Day"},
            {"employee_id": "active-a", "date": "2026-10-01", "status": "Absent"},
            {"employee_id": "active-a", "date": "2026-09-30", "status": "Present"},
            {"employee_id": "active-b", "date": "2026-10-20", "status": "Present"},
            {"employee_id": "inactive", "date": "2026-10-29", "status": "Present"},
        ]
        employees = [
            {"id": "active-a", "name": "A", "department": "Production"},
            {"id": "active-b", "name": "B"},
            {"id": "no-records", "name": "C", "department": "Office"},
        ]
        week_start, month_start, today = "2026-10-26", "2026-10-01", "2026-11-01"
        present_statuses = ("Present", "Half Day")

        result = summarize_attendance_records(records, employees, week_start, month_start, today)
        expected_per_employee = [
            {
                "employee_id": employee["id"],
                "name": employee["name"],
                "department": employee.get("department", ""),
                "week": sum(
                    1 for record in records
                    if record.get("employee_id") == employee["id"]
                    and (record.get("date") or "") >= week_start
                    and record.get("status") in present_statuses
                ),
                "month": sum(
                    1 for record in records
                    if record.get("employee_id") == employee["id"]
                    and (record.get("date") or "") >= month_start
                    and record.get("status") in present_statuses
                ),
            }
            for employee in employees
        ]
        daily = {"Present": 1}

        self.assertEqual(result["per_employee"], expected_per_employee)
        self.assertEqual(result["daily"], daily)
        self.assertEqual(result["daily_total"], sum(daily.values()))
        self.assertEqual(result["week_total"], sum(employee["week"] for employee in expected_per_employee))
        self.assertEqual(result["month_total"], sum(employee["month"] for employee in expected_per_employee))


if __name__ == "__main__":
    unittest.main()
