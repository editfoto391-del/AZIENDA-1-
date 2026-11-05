import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import { Card, Btn, Input, Select, Modal, PageHeader, Empty } from "@/components/common";
import { Users, Plus, CheckCheck, Pencil, CalendarCheck, Wallet, History, Landmark, Trash2, Search } from "lucide-react";
import { fmtMoney } from "@/lib/format";
import { useAuth } from "@/context/AuthContext";

const DEPTS = [
  "CHEMICAL",
  "COVER STITCHING",
  "FABRIC CUTTING",
  "TAILORING (TAPE EDGE)",
  "MATTRESS PACKING (PLASTING)",
  "MATTRESS COVERING AND LOADING",
  "DRIVING",
  "SECURITY",
];

const weekPeriod = (offset = 0) => {
  const start = new Date(`${today()}T00:00:00Z`);
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday + offset * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

const monthPeriod = (offset = 0) => {
  const start = new Date(`${today()}T00:00:00Z`);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() + offset);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

const isFullMonthPeriod = (start, end) => {
  const date = new Date(`${start}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const expectedStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const expectedEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return expectedStart === start && expectedEnd === end;
};

function SalaryEmployeeCard({ employee, weeklySalary, monthlySalary, deduction, saving, onWeeklySalaryChange, onMonthlySalaryChange, onSaveSalary, onDeductionChange, onSaveCut, onAddAdvance, onViewHistory, onDelete, fullMonthPeriod }) {
  const monthlyFixed = employee.pay_frequency === "monthly_fixed";
  const fixedWeeklySalary = Number(weeklySalary ?? employee.weekly_salary) || 0;
  const dailySalary = fixedWeeklySalary / 6;
  const remainingBalance = employee.available_balance - deduction;
  const takeHome = employee.gross_salary - deduction;
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-white shadow-sm transition-shadow hover:shadow-md" data-testid={`salary-row-${employee.employee_id}`}>
      <header className="flex items-start justify-between gap-3 border-b border-border bg-slate-50/80 px-4 py-3">
        <div><h3 className="font-bold text-slate-800">{employee.name}</h3><p className="mt-0.5 text-xs text-slate-500">{employee.department || "Employee"}{employee.active === false ? " · Inactive" : ""}</p></div>
        <button onClick={onViewHistory} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-white px-2.5 py-2 text-xs font-semibold text-primary hover:bg-primary/5" data-testid={`salary-history-${employee.employee_id}`}><History size={14} /> View past balances &amp; cuts</button>
      </header>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          {employee.pay_type === "piece" ? <div className="rounded-lg border border-border/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Piece pay this week</p>
            <p className="mt-1.5 font-mono text-lg font-bold text-slate-800">{fmtMoney(employee.piece_pay)}</p>
            <p className="text-xs text-slate-500">{employee.total_pieces} pieces recorded this period</p>
          </div> : monthlyFixed ? <div className="rounded-lg border border-border/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Fixed monthly salary</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-sm text-slate-500">R</span>
              <input aria-label={`Fixed monthly salary for ${employee.name}`} type="number" min="0.01" step="0.01" disabled={saving} value={monthlySalary ?? employee.monthly_salary ?? ""}
                onChange={(event) => onMonthlySalaryChange(event.target.value)}
                className="min-w-0 flex-1 rounded border border-input px-2 py-1.5 font-mono text-sm" data-testid={`salary-monthly-rate-${employee.employee_id}`} />
              <button disabled={saving} onClick={onSaveSalary} className="text-xs font-semibold text-primary hover:underline disabled:opacity-50" data-testid={`save-salary-rate-${employee.employee_id}`}>{saving ? "Saving…" : "Save"}</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Paid once per calendar month; attendance is still recorded daily.</p>
          </div> : <div className="rounded-lg border border-border/70 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Fixed weekly salary</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-sm text-slate-500">R</span>
              <input aria-label={`Fixed weekly salary for ${employee.name}`} type="number" min="0.01" step="0.01" disabled={saving} value={weeklySalary ?? employee.weekly_salary}
                onChange={(event) => onWeeklySalaryChange(event.target.value)}
                className="min-w-0 flex-1 rounded border border-input px-2 py-1.5 font-mono text-sm" data-testid={`salary-rate-${employee.employee_id}`} />
              <button disabled={saving} onClick={onSaveSalary} className="text-xs font-semibold text-primary hover:underline disabled:opacity-50" data-testid={`save-salary-rate-${employee.employee_id}`}>{saving ? "Saving…" : "Save"}</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Monday–Saturday · 45 ordinary hours/week</p>
            <p className="mt-1 text-[11px] text-slate-500">{fmtMoney(dailySalary)}/day · {fmtMoney(dailySalary / 8)}/hour weekday · {fmtMoney(dailySalary / 5)}/hour Saturday</p>
          </div>}
          <div className="rounded-lg border border-border/70 p-3">
            {employee.pay_type === "piece" ? <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Piece pay by week</p>
              <div className="mt-1.5 space-y-1">
                {employee.piece_weeks.length === 0 ? <p className="text-xs text-slate-500">No pieces recorded for this period.</p> : employee.piece_weeks.map((week) => (
                  <section key={week.week_start} className="border-t border-border/70 pt-2 text-xs text-slate-700">
                    <h4 className="font-semibold">Week {week.week_start}–{week.week_end}: {fmtMoney(week.pay)}</h4>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                      <span>Mon–Fri pieces: {week.weekday_pieces}</span>
                      <span>Saturday pieces (R60 bonus above 40): {week.saturday_pieces}</span>
                      <span>Weekday deficits: {week.weekday_deficit_pieces}</span>
                      <span>Surplus pieces: {week.total_surplus_pieces}</span>
                      <span>Unused surplus: {week.unused_surplus_pieces}</span>
                      <span>Pieces recovered: {week.recovered_pieces}</span>
                      <span>Unrecovered deficit: {week.unrecovered_weekday_deficit}</span>
                      <span>At R3.50: {week.high_rate_pieces}</span>
                      <span>At R2.50: {week.low_rate_pieces}</span>
                      <span>Mon–Fri pay: {fmtMoney(week.weekday_pay)}</span>
                      <span>Saturday pay: {fmtMoney(week.saturday_pay)}</span>
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer font-semibold text-primary">Daily production and calculation</summary>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full min-w-[470px] text-left text-[11px]">
                          <thead><tr className="border-b border-border text-slate-500">
                            <th className="py-1 pr-2">Date</th><th className="py-1 pr-2">Pieces / target</th>
                            <th className="py-1 pr-2">Surplus / deficit</th><th className="py-1 pr-2">Recovered</th>
                            <th className="py-1 pr-2">R3.50 / R2.50</th><th className="py-1">Pay</th>
                          </tr></thead>
                          <tbody>{week.days.map((day) => (
                            <tr key={day.date} className="border-b border-border/50">
                              <td className="py-1 pr-2">{day.date}</td>
                              <td className="py-1 pr-2">{day.recorded ? `${day.pieces} / ${day.target}` : `Not recorded / ${day.target}`}</td>
                              <td className="py-1 pr-2">{!day.recorded ? "—" : day.surplus ? `+${day.surplus}` : day.deficit ? `−${day.deficit}` : "—"}</td>
                              <td className="py-1 pr-2">{day.recovered_previous_deficits}</td>
                              <td className="py-1 pr-2">{day.high_rate_pieces} / {day.low_rate_pieces}</td>
                              <td className="py-1">{fmtMoney(day.pay)}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </details>
                  </section>
                ))}
              </div>
            </> : <>
              {monthlyFixed ? <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pay earned this month</p>
                <p className="mt-1.5 font-mono text-lg font-bold text-slate-800">{!employee.monthly_salary ? "Set monthly salary" : fullMonthPeriod ? fmtMoney(employee.gross_salary) : "Select a full month"}</p>
                <p className="text-xs text-slate-500">{employee.present_days} full + {employee.half_days} half days recorded</p>
                {!fullMonthPeriod && <p className="mt-1 text-xs text-amber-700">Monthly pay is included only for a complete calendar month.</p>}
              </> : <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pay earned this week</p>
                <p className="mt-1.5 font-mono text-lg font-bold text-slate-800">{fmtMoney(employee.gross_salary)}</p>
                <p className="text-xs text-slate-500">{employee.present_days} full + {employee.half_days} half · {employee.regular_hours + employee.overtime_hours} total hours</p>
                <p className="mt-1 text-xs text-slate-500">{fmtMoney(employee.regular_pay)} regular · {fmtMoney(employee.overtime_pay)} overtime ({employee.overtime_hours}h × R20)</p>
              </>}
            </>}
          </div>
        </div>
        <section className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <h4 className="text-sm font-bold text-slate-800">Borrowed balance</h4>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div><p className="text-xs text-slate-600">Owed at start of {monthlyFixed ? "month" : "week"}</p><p className="mt-0.5 font-mono font-semibold">{fmtMoney(employee.balance_before_period)}</p></div>
            <label className="block"><span className="block text-xs text-slate-600">Deduct this {monthlyFixed ? "month" : "week"}</span><span className="mt-0.5 flex items-center gap-1 rounded border border-input bg-white px-2"><span className="text-xs text-slate-500">R</span><input aria-label={`Deduct from balance for ${employee.name}`} type="number" min="0" max={Math.min(employee.available_balance, employee.gross_salary)} step="0.01" value={deduction}
              onChange={(event) => onDeductionChange(event.target.value)}
              className="min-w-0 w-full border-0 bg-transparent py-1.5 font-mono text-sm outline-none" data-testid={`salary-cut-${employee.employee_id}`} /></span></label>
          </div>
          <p className="mt-2 border-t border-amber-200/70 pt-2 text-sm">Still owed after this {monthlyFixed ? "month" : "week"}: <strong className="font-mono">{fmtMoney(remainingBalance)}</strong></p>
          {employee.balance_before_period <= 0 && <p className="mt-1 text-xs text-slate-500">No borrowed balance was owed at the start of this {monthlyFixed ? "month" : "week"}.</p>}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Take-home pay after deduction</p><p className="font-mono text-xl font-bold text-emerald-700">{fmtMoney(takeHome)}</p></div>
          <div className="flex flex-wrap gap-2">
            <Btn variant="outline" disabled={saving} onClick={onAddAdvance} data-testid={`salary-advance-${employee.employee_id}`}>+ Add borrowed balance</Btn>
            <Btn disabled={saving || (monthlyFixed && (!fullMonthPeriod || !employee.monthly_salary))} onClick={onSaveCut} data-testid={`save-salary-cut-${employee.employee_id}`}>{saving ? "Saving…" : `Save this ${monthlyFixed ? "month" : "week"}’s cut`}</Btn>
            {onDelete && <Btn variant="danger" disabled={saving} onClick={onDelete} data-testid={`delete-salary-employee-${employee.employee_id}`}><Trash2 size={15} /> Delete employee</Btn>}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [deletedEmployees, setDeletedEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [pieceRecords, setPieceRecords] = useState([]);
  const [pieceDraft, setPieceDraft] = useState({});
  const [pieceSaving, setPieceSaving] = useState({});
  const [pieceLoading, setPieceLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(today());
  const [empModal, setEmpModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rosterImporting, setRosterImporting] = useState(false);
  const [rosterResetting, setRosterResetting] = useState(false);
  const [attendanceSaving, setAttendanceSaving] = useState({});
  const [section, setSection] = useState("attendance");
  const [overtimeDraft, setOvertimeDraft] = useState({});
  const [workTimeDraft, setWorkTimeDraft] = useState({});
  const [shiftModeDraft, setShiftModeDraft] = useState({});
  const [workTimeSaving, setWorkTimeSaving] = useState({});
  const [salaryStart, setSalaryStart] = useState(() => monthPeriod().start);
  const [salaryEnd, setSalaryEnd] = useState(() => monthPeriod().end);
  const [salarySearch, setSalarySearch] = useState("");
  const [salaryDepartment, setSalaryDepartment] = useState("");
  const [salaryReport, setSalaryReport] = useState(null);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [salaryCuts, setSalaryCuts] = useState({});
  const [salaryWeeklySalaries, setSalaryWeeklySalaries] = useState({});
  const [salaryMonthlySalaries, setSalaryMonthlySalaries] = useState({});
  const [salarySaving, setSalarySaving] = useState({});
  const [historyEmployee, setHistoryEmployee] = useState(null);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [advanceModal, setAdvanceModal] = useState(null);

  const load = () => {
    Promise.all([api.get("/employees"), api.get("/attendance"), api.get("/attendance/summary")])
      .then(([employeeData, attendanceData, summaryData]) => { setEmployees(employeeData); setRecords(attendanceData); setSummary(summaryData); })
      .catch((e) => toast.error(apiError(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    let activeRequest = true;
    setPieceLoading(true);
    api.get("/piece-production", { start_date: date, end_date: date })
      .then((data) => { if (activeRequest) setPieceRecords(data); })
      .catch((error) => { if (activeRequest) toast.error(apiError(error)); })
      .finally(() => { if (activeRequest) setPieceLoading(false); });
    return () => { activeRequest = false; };
  }, [date]);

  const active = employees.filter((e) => e.active !== false);
  const statusOf = (eid) => records.find((r) => r.employee_id === eid && r.date === date)?.status;
  const groups = useMemo(() => {
    const g = {};
    active.forEach((e) => { (g[e.department || "Other"] ||= []).push(e); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [active]);
  const present = active.filter((e) => ["Present", "Half Day"].includes(statusOf(e.id))).length;
  const absent = active.filter((e) => statusOf(e.id) === "Absent").length;

  const applyAttendanceRecord = (employeeId, attendanceDate, previousStatus, nextStatus) => {
    const wasPresent = ["Present", "Half Day"].includes(previousStatus);
    const isPresent = ["Present", "Half Day"].includes(nextStatus);
    const weekStart = summary?.week_start;
    const monthStart = summary?.month_start;
    setSummary((current) => {
      if (!current) return current;
      const daily = { ...current.daily };
      if (attendanceDate === today()) {
        if (previousStatus) daily[previousStatus] = Math.max(0, (daily[previousStatus] || 0) - 1);
        if (nextStatus) daily[nextStatus] = (daily[nextStatus] || 0) + 1;
        Object.keys(daily).forEach((status) => { if (!daily[status]) delete daily[status]; });
      }
      const weekDelta = attendanceDate >= weekStart ? Number(isPresent) - Number(wasPresent) : 0;
      const monthDelta = attendanceDate >= monthStart ? Number(isPresent) - Number(wasPresent) : 0;
      return {
        ...current,
        daily,
        daily_total: attendanceDate === today()
          ? current.daily_total + Number(!!nextStatus) - Number(!!previousStatus)
          : current.daily_total,
        week_total: current.week_total + weekDelta,
        month_total: current.month_total + monthDelta,
        per_employee: current.per_employee.map((item) => item.employee_id !== employeeId ? item : {
          ...item,
          week: item.week + weekDelta,
          month: item.month + monthDelta,
        }),
      };
    });
  };
  const saveAttendance = async (employee, status, times) => {
    if (attendanceSaving[employee.id]) return;
    const previous = records.find((item) => item.employee_id === employee.id && item.date === date);
    const next = {
      ...previous,
      employee_id: employee.id,
      employee_name: employee.name,
      department: employee.department || "",
      date,
      status,
      overtime_hours: status === "Absent" ? 0 : previous?.overtime_hours || 0,
      start_time: status === "Absent" ? null : times.start_time,
      end_time: status === "Absent" ? null : times.end_time,
    };
    setAttendanceSaving((current) => ({ ...current, [employee.id]: true }));
    setRecords((current) => previous
      ? current.map((item) => item.id === previous.id ? next : item)
      : [...current, next]);
    applyAttendanceRecord(employee.id, date, previous?.status, status);
    try {
      const saved = await api.post("/attendance", next);
      setRecords((current) => current.map((item) =>
        item.employee_id === employee.id && item.date === date ? saved : item,
      ));
      setWorkTimeDraft((current) => { const updated = { ...current }; delete updated[employee.id]; return updated; });
      if (status === "Absent") {
        setShiftModeDraft((current) => { const updated = { ...current }; delete updated[employee.id]; return updated; });
      }
      return true;
    } catch (error) {
      setRecords((current) => {
        const withoutCurrent = current.filter((item) => item.employee_id !== employee.id || item.date !== date);
        return previous ? [...withoutCurrent, previous] : withoutCurrent;
      });
      applyAttendanceRecord(employee.id, date, status, previous?.status);
      toast.error(apiError(error));
      return false;
    } finally {
      setAttendanceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const mark = async (emp, status) => {
    const record = records.find((item) => item.employee_id === emp.id && item.date === date);
    const saturday = new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
    const times = status === "Absent"
      ? { start_time: null, end_time: null }
      : {
        start_time: record?.start_time || "08:00",
        end_time: record?.end_time || (saturday ? "13:00" : "17:00"),
      };
    await saveAttendance(emp, status, times);
  };
  const saveWorkTime = async (employee, selectedTimes) => {
    const record = records.find((item) => item.employee_id === employee.id && item.date === date);
    if (!record || !["Present", "Half Day"].includes(record.status)) return;
    const draft = workTimeDraft[employee.id] || {};
    const startTime = selectedTimes?.start_time ?? draft.start_time ?? record.start_time ?? "";
    const endTime = selectedTimes?.end_time ?? draft.end_time ?? record.end_time ?? "";
    if (Boolean(startTime) !== Boolean(endTime)) return toast.error("Enter both the start and end times");
    setWorkTimeSaving((current) => ({ ...current, [employee.id]: true }));
    try {
      const saved = await saveAttendance(employee, record.status, {
        start_time: startTime || null,
        end_time: endTime || null,
      });
      if (saved && startTime && endTime) toast.success(`Work times saved for ${employee.name}`);
    } finally {
      setWorkTimeSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const savePieceCount = async (employee) => {
    const previous = pieceRecords.find((item) => item.employee_id === employee.id && item.date === date);
    if (pieceLoading) return;
    const pieces = Number(pieceDraft[employee.id] ?? previous?.pieces ?? 0);
    if (!Number.isInteger(pieces) || pieces < 0) return toast.error("Pieces must be a whole number of zero or more");
    const optimistic = {
      ...previous,
      employee_id: employee.id,
      employee_name: employee.name,
      date,
      pieces,
    };
    setPieceSaving((current) => ({ ...current, [employee.id]: true }));
    setPieceRecords((current) => previous
      ? current.map((item) => item.employee_id === employee.id && item.date === date ? optimistic : item)
      : [...current, optimistic]);
    try {
      const saved = await api.post("/piece-production", optimistic);
      setPieceRecords((current) => current.map((item) =>
        item.employee_id === employee.id && item.date === date ? saved : item,
      ));
      setPieceDraft((current) => { const next = { ...current }; delete next[employee.id]; return next; });
      toast.success(`Piece count saved for ${employee.name}`);
      if (salaryReport && date >= salaryStart && date <= salaryEnd) await loadSalaries();
    } catch (error) {
      setPieceRecords((current) => {
        const remaining = current.filter((item) => item.employee_id !== employee.id || item.date !== date);
        return previous ? [...remaining, previous] : remaining;
      });
      toast.error(apiError(error));
    } finally {
      setPieceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const deletePieceCount = async (employee) => {
    const previous = pieceRecords.find((item) => item.employee_id === employee.id && item.date === date);
    if (!previous || pieceLoading || pieceSaving[employee.id]) return;
    if (!window.confirm(`Delete the ${previous.pieces}-piece production record for ${employee.name} on ${date}? The entire week’s pay will be recalculated.`)) return;
    setPieceSaving((current) => ({ ...current, [employee.id]: true }));
    setPieceRecords((current) => current.filter((item) => item.id !== previous.id));
    try {
      await api.del(`/piece-production/${previous.id}`);
      toast.success(`Piece count deleted for ${employee.name}`);
      if (salaryReport && date >= salaryStart && date <= salaryEnd) await loadSalaries();
    } catch (error) {
      setPieceRecords((current) => [...current, previous]);
      toast.error(apiError(error));
    } finally {
      setPieceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const saveOvertime = async (employee) => {
    const record = records.find((item) => item.employee_id === employee.id && item.date === date);
    if (!record || !["Present", "Half Day"].includes(record.status)) return;
    const overtime = Number(overtimeDraft[employee.id] ?? record.overtime_hours ?? 0);
    if (!Number.isFinite(overtime) || overtime < 0) return toast.error("Overtime hours must be zero or more");
    try {
      const updated = await api.post("/attendance", { employee_id: employee.id, date, status: record.status, overtime_hours: overtime });
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      setOvertimeDraft((current) => { const next = { ...current }; delete next[employee.id]; return next; });
    } catch (e) { toast.error(apiError(e)); }
  };
  const markAll = async () => {
    if (busy) return; setBusy(true);
    try { await api.post("/attendance/bulk", { date, status: "Present", employee_ids: active.map((e) => e.id) }); toast.success("All marked present"); load(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const importPayrollRoster = async () => {
    if (!window.confirm("Update the employee list to match the supplied 31-person roster? This updates salaries and departments, merges duplicate profiles, and archives employees not on the list. Attendance and salary history will be kept.")) return;
    setRosterImporting(true);
    try {
      const result = await api.post("/employees/import-roster", {});
      toast.success(`Employee list updated: ${result.added} added, ${result.updated} updated, ${result.duplicates_archived} duplicates merged, ${result.unlisted_archived} unlisted archived`);
      load();
      if (salaryReport) await loadSalaries();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setRosterImporting(false);
    }
  };
  const resetPayrollRosterAndAttendance = async () => {
    if (!window.confirm("This will archive employees not shown in the supplied roster, merge duplicate profiles with the same name, permanently delete all attendance history, and mark the roster present for the full current work week. This cannot be undone. Continue?")) return;
    setRosterResetting(true);
    try {
      const result = await api.post("/employees/reconcile-payroll-roster", {});
      toast.success(
        `Roster updated: ${result.added} added, ${result.duplicates_archived} duplicates merged, ${result.unlisted_archived} unlisted archived. ${result.attendance_deleted} attendance records deleted; ${result.attendance_created} present records created for ${result.week_start}–${result.week_end}.`,
      );
      load();
      const period = weekPeriod();
      setSalaryStart(period.start);
      setSalaryEnd(period.end);
      await loadSalaries(period.start, period.end);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setRosterResetting(false);
    }
  };
  const saveEmp = async () => {
    if (!empModal.name.trim()) return toast.error("Name required");
    if (!DEPTS.includes(empModal.department)) return toast.error("Select a standard department");
    try { empModal.id ? await api.put(`/employees/${empModal.id}`, empModal) : await api.post("/employees", empModal); setEmpModal(null); load(); toast.success("Employee saved"); }
    catch (e) { toast.error(apiError(e)); }
  };
  const deleteEmployee = async (employee) => {
    if (!window.confirm(`Permanently delete ${employee.name} from this profile? The employee will appear in Deleted employees; attendance and salary history will be retained.`)) return;
    try {
      await api.del(`/employees/${employee.id}`);
      setEmployees((current) => current.filter((item) => item.id !== employee.id));
      toast.success("Employee permanently deleted; history retained");
    } catch (error) {
      toast.error(apiError(error));
      return;
    }
    try { setDeletedEmployees(await api.get("/employees/deleted")); }
    catch (error) { toast.error(`Employee deleted, but deleted-employee archive could not be refreshed: ${apiError(error)}`); }
    if (salaryReport) await loadSalaries();
  };
  const loadSalaries = async (startDate = salaryStart, endDate = salaryEnd) => {
    if (!startDate || !endDate) return toast.error("Select both salary period dates");
    if (endDate < startDate) return toast.error("The end date must be on or after the start date");
    setSalaryLoading(true);
    try {
      const report = await api.get("/salaries", { start_date: startDate, end_date: endDate });
      setSalaryReport(report);
      setSalaryCuts(Object.fromEntries(report.employees.map((employee) => [employee.employee_id, String(employee.cut || 0)])));
      setSalaryWeeklySalaries(Object.fromEntries(report.employees.map((employee) => [employee.employee_id, String(employee.weekly_salary ?? 0)])));
      setSalaryMonthlySalaries(Object.fromEntries(report.employees.map((employee) => [employee.employee_id, String(employee.monthly_salary ?? "")])));
    } catch (e) { toast.error(apiError(e)); } finally { setSalaryLoading(false); }
  };
  const saveSalaryRate = async (employee) => {
    if (employee.pay_frequency === "monthly_fixed") {
      const monthlySalary = Number(salaryMonthlySalaries[employee.employee_id]);
      if (!Number.isFinite(monthlySalary) || monthlySalary <= 0) return toast.error("Monthly salary must be greater than zero");
      setSalarySaving((current) => ({ ...current, [employee.employee_id]: true }));
      try {
        await api.put(`/salaries/rates/${employee.employee_id}`, { monthly_salary: monthlySalary });
        toast.success(`Monthly salary updated for ${employee.name}`);
        await loadSalaries();
      } catch (e) { toast.error(apiError(e)); } finally {
        setSalarySaving((current) => ({ ...current, [employee.employee_id]: false }));
      }
      return;
    }
    const weeklySalary = Number(salaryWeeklySalaries[employee.employee_id]);
    if (!Number.isFinite(weeklySalary) || weeklySalary <= 0) return toast.error("Weekly salary must be greater than zero");
    setSalarySaving((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put(`/salaries/rates/${employee.employee_id}`, { weekly_salary: weeklySalary });
      toast.success(`Weekly salary updated for ${employee.name}`);
      await loadSalaries();
    } catch (e) { toast.error(apiError(e)); } finally {
      setSalarySaving((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };
  const saveSalaryCut = async (employee) => {
    if (employee.pay_frequency === "monthly_fixed" && !isFullMonthPeriod(salaryStart, salaryEnd)) {
      return toast.error("Select a complete calendar month before saving a salary cut");
    }
    const amount = Number(salaryCuts[employee.employee_id] || 0);
    if (!Number.isFinite(amount) || amount < 0) return toast.error("Cut amount must be zero or more");
    setSalarySaving((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/cuts", {
        employee_id: employee.employee_id, start_date: salaryStart, end_date: salaryEnd, amount,
      });
      toast.success("Salary cut saved and balance updated");
      await loadSalaries();
    } catch (e) { toast.error(apiError(e)); } finally {
      setSalarySaving((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };
  const saveAdvance = async () => {
    if (!advanceModal || !(Number(advanceModal.amount) > 0)) return toast.error("Enter an advance amount greater than zero");
    try {
      await api.post("/salaries/advances", { ...advanceModal, amount: Number(advanceModal.amount) });
      toast.success("Salary advance recorded");
      setAdvanceModal(null);
      await loadSalaries();
    } catch (e) { toast.error(apiError(e)); }
  };
  const clearSalaryHistory = async () => {
    if (!historyEmployee || historyClearing) return;
    const confirmed = window.confirm(
      `Permanently clear all borrowed amounts and salary cuts for ${historyEmployee.name}? This will reset their outstanding balance to R 0.00. This action cannot be undone.`,
    );
    if (!confirmed) return;
    setHistoryClearing(true);
    try {
      await api.del(`/salaries/history/${historyEmployee.employee_id}`);
      toast.success(`Balance and cut history cleared for ${historyEmployee.name}`);
      setHistoryEmployee(null);
      await loadSalaries();
    } catch (e) { toast.error(apiError(e)); } finally { setHistoryClearing(false); }
  };
  const salaryDepartments = [...new Set((salaryReport?.employees || [])
    .map((employee) => employee.department || "Other"))].sort((a, b) => a.localeCompare(b));
  const filteredSalaryEmployees = salaryReport?.employees.filter((employee) =>
    (salaryDepartment === "" || (employee.department || "Other") === salaryDepartment)
    && `${employee.name} ${employee.department || ""}`.toLocaleLowerCase().includes(salarySearch.trim().toLocaleLowerCase()),
  ) || [];
  const salaryTotals = filteredSalaryEmployees.reduce((totals, employee) => ({
    gross: totals.gross + employee.gross_salary,
    cuts: totals.cuts + employee.cut,
    net: totals.net + employee.net_salary,
    balance: totals.balance + employee.balance,
  }), { gross: 0, cuts: 0, net: 0, balance: 0 });
  const chooseSalaryWeek = (offset) => {
    const period = weekPeriod(offset);
    setSalaryStart(period.start);
    setSalaryEnd(period.end);
    loadSalaries(period.start, period.end);
  };
  const chooseSalaryMonth = (offset) => {
    const period = monthPeriod(offset);
    setSalaryStart(period.start);
    setSalaryEnd(period.end);
    loadSalaries(period.start, period.end);
  };
  const Stat = ({ l, v, cls, k }) => <Card className="p-4" data-testid={`att-${k}`}><p className="text-xs text-slate-400 uppercase font-semibold">{l}</p><p className={`text-2xl font-bold font-mono mt-1 ${cls}`}>{v}</p></Card>;

  return (
    <div className="space-y-6">
      <PageHeader title="Attendance" subtitle="Tap Present or Absent for each employee">
        {section === "attendance" && <>
          <Btn variant="outline" onClick={() => setEmpModal({ name: "", department: "", active: true })} data-testid="add-employee-btn"><Plus size={16} /> Employee</Btn>
          {(user?.is_admin || user?.role === "admin" || user?.is_owner) && <Btn variant="outline" disabled={rosterImporting} onClick={importPayrollRoster} data-testid="import-payroll-roster-btn">{rosterImporting ? "Updating list…" : "Update employee list"}</Btn>}
          <Btn disabled={loading || busy || !active.length} onClick={markAll} data-testid="mark-all-present-btn"><CheckCheck size={16} /> Mark All Present</Btn>
        </>}
      </PageHeader>
      <div className="flex gap-2 border-b border-border">
        <button onClick={() => setSection("attendance")} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "attendance" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="attendance-section-tab"><CalendarCheck size={16} /> Attendance</button>
        {(user?.is_admin || user?.role === "admin" || user?.is_owner) && <button onClick={() => setSection("salaries")} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "salaries" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="salary-section-tab"><Wallet size={16} /> Salaries</button>}
        {user?.is_owner && <button onClick={async () => {
          setSection("deleted");
          try { setDeletedEmployees(await api.get("/employees/deleted")); }
          catch (error) { toast.error(apiError(error)); }
        }} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "deleted" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="deleted-employees-tab"><Trash2 size={15} /> Deleted employees ({deletedEmployees.length})</button>}
      </div>
      {section === "deleted" && user?.is_owner ? (
        <Card className="overflow-hidden">
          {deletedEmployees.length === 0 ? <Empty icon={Users} title="No deleted employees" /> : <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 text-left text-xs text-slate-400"><th className="px-4 py-3">Name</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Deleted</th></tr></thead>
              <tbody>{deletedEmployees.map((employee) => <tr key={employee.id} className="border-t border-border/60" data-testid={`deleted-employee-row-${employee.id}`}>
                <td className="px-4 py-3 font-semibold text-slate-800">{employee.name}</td><td className="px-4 py-3 text-slate-500">{employee.department || "—"}</td><td className="px-4 py-3 text-slate-500">{employee.deleted_at ? new Date(employee.deleted_at).toLocaleString() : "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </Card>
      ) : section === "salaries" && (user?.is_admin || user?.role === "admin" || user?.is_owner) ? (
        <div className="space-y-4">
          <Card className="space-y-4 p-4">
            <div>
              <h2 className="font-display text-lg font-bold text-slate-800">Choose pay period</h2>
              <p className="mt-1 text-sm text-slate-500">Cuts are saved against the selected dates, and previous balances carry forward automatically. Monthly fixed salaries are included only for a complete calendar month.</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-44"><Input label="Period starts" type="date" value={salaryStart} onChange={(event) => { setSalaryStart(event.target.value); setSalaryReport(null); }} data-testid="salary-start-date" /></div>
              <div className="w-44"><Input label="Period ends" type="date" value={salaryEnd} onChange={(event) => { setSalaryEnd(event.target.value); setSalaryReport(null); }} data-testid="salary-end-date" /></div>
              <Btn variant="outline" disabled={salaryLoading} onClick={() => chooseSalaryMonth(0)} data-testid="salary-this-month-btn">This month</Btn>
              <Btn variant="outline" disabled={salaryLoading} onClick={() => chooseSalaryMonth(-1)} data-testid="salary-last-month-btn">Last month</Btn>
              <Btn variant="outline" disabled={salaryLoading} onClick={() => chooseSalaryWeek(0)} data-testid="salary-this-week-btn">This week (Mon–Sun)</Btn>
              <Btn variant="outline" disabled={salaryLoading} onClick={() => chooseSalaryWeek(-1)} data-testid="salary-last-week-btn">Last week</Btn>
              <Btn disabled={salaryLoading} onClick={loadSalaries} data-testid="load-salaries-btn">{salaryLoading ? "Loading..." : "Show salaries"}</Btn>
              <Btn variant="danger" disabled={rosterResetting || salaryLoading} onClick={resetPayrollRosterAndAttendance} data-testid="reset-payroll-roster-btn">{rosterResetting ? "Resetting roster…" : "Reset roster and attendance"}</Btn>
            </div>
            <p className="border-t border-border pt-3 text-xs leading-relaxed text-slate-500">Weekly salaries are divided by six paid days. Yaseen Uncle and Ameena receive fixed monthly pay once per calendar month; record their attendance daily. Overtime is paid separately at R20 per hour for weekly-paid staff. Ayanda and Asive remain on piece pay.</p>
          </Card>
          {salaryReport && <Card className="overflow-hidden">
            {salaryReport.employees.length === 0 ? <Empty icon={Users} title="No employees found" /> : <>
            <div className="grid grid-cols-2 gap-3 border-b border-border p-4 sm:grid-cols-4">
              {[["Gross payroll", salaryTotals.gross], ["Cuts this period", salaryTotals.cuts], ["Net pay", salaryTotals.net], ["Outstanding balances", salaryTotals.balance]].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border/70 bg-gradient-to-br from-white to-slate-50 p-3 transition-transform duration-200 hover:-translate-y-0.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 font-mono text-lg font-bold text-slate-800">{fmtMoney(value)}</p>
                </div>
              ))}
            </div>
            <div className="border-b border-border p-4">
              <div className="flex flex-wrap items-end gap-3">
              <div className="relative w-full max-w-sm">
                <Search size={16} className="absolute left-3 top-[2.4rem] text-slate-400" aria-hidden="true" />
                <Input label="Search employees" type="search" value={salarySearch}
                  onChange={(event) => setSalarySearch(event.target.value)} placeholder="Name or department"
                  className="pl-9" data-testid="salary-employee-search" />
              </div>
              <div className="w-full max-w-xs">
                <Select label="Department" value={salaryDepartment} onChange={(event) => setSalaryDepartment(event.target.value)} data-testid="salary-department-filter">
                  <option value="">All departments</option>
                  {salaryDepartments.map((department) => <option key={department} value={department}>{department}</option>)}
                </Select>
              </div>
              </div>
            </div>
            {filteredSalaryEmployees.length === 0 ? <Empty icon={Users} title="No employees match your search" /> : <div className="grid gap-4 p-4 md:grid-cols-2">
              {filteredSalaryEmployees.map((employee) => {
                const deduction = Number(salaryCuts[employee.employee_id] ?? employee.cut) || 0;
                const saving = !!salarySaving[employee.employee_id];
                return <SalaryEmployeeCard
                  key={employee.employee_id}
                  employee={employee}
                  weeklySalary={salaryWeeklySalaries[employee.employee_id]}
                  monthlySalary={salaryMonthlySalaries[employee.employee_id]}
                  deduction={deduction}
                  saving={saving}
                  fullMonthPeriod={isFullMonthPeriod(salaryStart, salaryEnd)}
                  onWeeklySalaryChange={(value) => setSalaryWeeklySalaries((current) => ({ ...current, [employee.employee_id]: value }))}
                  onMonthlySalaryChange={(value) => setSalaryMonthlySalaries((current) => ({ ...current, [employee.employee_id]: value }))}
                  onSaveSalary={() => saveSalaryRate(employee)}
                  onDeductionChange={(value) => setSalaryCuts((current) => ({ ...current, [employee.employee_id]: value }))}
                  onSaveCut={() => saveSalaryCut(employee)}
                  onAddAdvance={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, date: today(), amount: "", notes: "" })}
                  onViewHistory={() => setHistoryEmployee(employee)}
                  onDelete={user?.is_owner ? () => deleteEmployee({ id: employee.employee_id, name: employee.name }) : undefined}
                />;
              })}
            </div>}
            </>}
          </Card>}
        </div>
      ) : (
      <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-48"><Input label="Date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setOvertimeDraft({}); setWorkTimeDraft({}); setShiftModeDraft({}); }} data-testid="attendance-date-input" /></div>
        <p className="pb-2 text-sm text-slate-500">Select a shift for hourly employees. Ayanda Tailor and Asive Tailor are paid by weekly piece count.</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat l="Present (day)" v={loading ? "..." : present} cls="text-emerald-600" k="day-present" />
        <Stat l="Absent (day)" v={loading ? "..." : absent} cls="text-red-600" k="day-absent" />
        <Stat l="Not marked" v={loading ? "..." : active.length - present - absent} cls="text-slate-500" k="day-unmarked" />
        <Stat l="Present days (week)" v={loading ? "..." : summary?.week_total ?? 0} cls="text-slate-800" k="week" />
        <Stat l="Present days (month)" v={loading ? "..." : summary?.month_total ?? 0} cls="text-slate-800" k="month" />
      </div>
      {loading ? <Card><p className="p-6 text-sm text-slate-400" role="status">Loading employees...</p></Card> : active.length === 0 ? <Card><Empty icon={Users} title="No employees yet" hint="Add employees with the + Employee button." /></Card> : groups.map(([dept, list]) => (
        <Card key={dept} className="p-4">
          <p className="text-xs font-bold uppercase text-slate-500 mb-3">{dept} <span className="text-slate-300">· {list.length}</span></p>
          <div className="space-y-2">{list.map((e) => {
            const s = statusOf(e.id);
            const per = summary?.per_employee?.find((p) => p.employee_id === e.id);
            const record = records.find((item) => item.employee_id === e.id && item.date === date);
            const timeDraft = workTimeDraft[e.id] || {};
            const startTime = timeDraft.start_time ?? record?.start_time ?? "";
            const endTime = timeDraft.end_time ?? record?.end_time ?? "";
            const isSaturday = new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
            const shiftMode = shiftModeDraft[e.id] || (
              startTime === "08:00" && endTime === "17:00" ? "08:00-17:00"
                : startTime === "08:00" && endTime === "13:00" ? "08:00-13:00"
                  : startTime && endTime ? "custom"
                    : isSaturday ? "08:00-13:00" : "08:00-17:00"
            );
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2" data-testid={`att-row-${e.id}`}>
                <div className="flex-1 min-w-[140px]"><p className="font-semibold text-slate-800">{e.name}</p><p className="text-[11px] text-slate-400">Week {per?.week ?? 0} · Month {per?.month ?? 0} days</p></div>
                {e.pay_type === "piece" && <>
                  <div className="w-32"><Input label="Pieces today" type="number" min="0" step="1"
                    value={pieceDraft[e.id] ?? pieceRecords.find((item) => item.employee_id === e.id && item.date === date)?.pieces ?? 0}
                    onChange={(event) => setPieceDraft((current) => ({ ...current, [e.id]: event.target.value }))}
                    disabled={pieceLoading || !!pieceSaving[e.id]} data-testid={`piece-count-${e.id}`} /></div>
                  <Btn variant="outline" disabled={pieceLoading || !!pieceSaving[e.id]}
                    onClick={() => savePieceCount(e)} data-testid={`save-piece-count-${e.id}`}>
                    {pieceSaving[e.id] ? "Saving…" : "Save pieces"}
                  </Btn>
                  {pieceRecords.some((item) => item.employee_id === e.id && item.date === date) && <Btn
                    variant="danger" disabled={pieceLoading || !!pieceSaving[e.id]}
                    onClick={() => deletePieceCount(e)} data-testid={`delete-piece-count-${e.id}`}>
                    Delete
                  </Btn>}
                </>}
                <button disabled={!!attendanceSaving[e.id]} onClick={() => mark(e, "Present")} data-testid={`present-btn-${e.id}`} className={`h-12 w-32 rounded-xl text-sm font-bold border-2 transition-colors disabled:opacity-60 ${s === "Present" ? "bg-emerald-600 border-emerald-600 text-white" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>{attendanceSaving[e.id] && s === "Present" ? "Saving…" : "Present"}</button>
                <button disabled={!!attendanceSaving[e.id]} onClick={() => mark(e, "Absent")} data-testid={`absent-btn-${e.id}`} className={`h-12 w-32 rounded-xl text-sm font-bold border-2 transition-colors disabled:opacity-60 ${s === "Absent" ? "bg-red-600 border-red-600 text-white" : "border-red-200 text-red-700 hover:bg-red-50"}`}>{attendanceSaving[e.id] && s === "Absent" ? "Saving…" : "Absent"}</button>
                {e.pay_type !== "piece" && ["Present", "Half Day"].includes(s) && <>
                  <div className="w-40"><Select label="Work shift" value={shiftMode} disabled={!!attendanceSaving[e.id] || !!workTimeSaving[e.id]}
                    onChange={(event) => {
                      const mode = event.target.value;
                      setShiftModeDraft((current) => ({ ...current, [e.id]: mode }));
                      if (mode === "custom") {
                        if (shiftMode !== "custom") setWorkTimeDraft((current) => ({ ...current, [e.id]: { start_time: "", end_time: "" } }));
                        return;
                      }
                      const [start_time, end_time] = mode.split("-");
                      setWorkTimeDraft((current) => ({ ...current, [e.id]: { start_time, end_time } }));
                      saveWorkTime(e, { start_time, end_time });
                    }} data-testid={`attendance-shift-${e.id}`}>
                    <option value="08:00-17:00">8:00–17:00</option>
                    <option value="08:00-13:00">8:00–13:00</option>
                    <option value="custom">Custom</option>
                  </Select></div>
                  {shiftMode === "custom" && <>
                  <div className="w-32"><Input label="From" type="time" value={startTime}
                    onChange={(event) => setWorkTimeDraft((current) => ({ ...current, [e.id]: { ...current[e.id], start_time: event.target.value } }))}
                    data-testid={`attendance-start-time-${e.id}`} /></div>
                  <div className="w-32"><Input label="To" type="time" value={endTime}
                    onChange={(event) => setWorkTimeDraft((current) => ({ ...current, [e.id]: { ...current[e.id], end_time: event.target.value } }))}
                    data-testid={`attendance-end-time-${e.id}`} /></div>
                  <Btn variant="outline" disabled={!!workTimeSaving[e.id]} onClick={() => saveWorkTime(e)} data-testid={`attendance-save-times-${e.id}`}>
                    {workTimeSaving[e.id] ? "Saving..." : "Save hours"}
                  </Btn>
                  </>}
                  {!((record?.start_time && record?.end_time) || shiftMode !== "custom") && <div className="w-32"><Input label="Overtime hours" type="number" min="0" step="0.25" value={overtimeDraft[e.id] ?? record?.overtime_hours ?? 0}
                  onChange={(event) => setOvertimeDraft((current) => ({ ...current, [e.id]: event.target.value }))} onBlur={() => saveOvertime(e)} data-testid={`attendance-overtime-${e.id}`} /></div>}
                </>}
                <button onClick={() => setEmpModal({ ...e })} className="text-slate-300 hover:text-primary" data-testid={`edit-employee-${e.id}`}><Pencil size={15} /></button>
                {user?.is_owner && <button onClick={() => deleteEmployee(e)} className="text-slate-300 hover:text-red-600" aria-label={`Permanently delete ${e.name}`} title="Permanently delete employee" data-testid={`delete-employee-${e.id}`}><Trash2 size={15} /></button>}
              </div>);
          })}</div>
        </Card>))}
      <Modal open={!!empModal} onClose={() => setEmpModal(null)} title={empModal?.id ? "Edit Employee" : "Add Employee"}>
        {empModal && <div className="space-y-4">
          <Input label="Name *" value={empModal.name} onChange={(e) => setEmpModal({ ...empModal, name: e.target.value })} data-testid="employee-name-input" />
          <Select label="Department" value={empModal.department || ""} onChange={(e) => setEmpModal({ ...empModal, department: e.target.value })} data-testid="employee-dept-select">
            <option value="">Select a department</option>
            {empModal.department && !DEPTS.includes(empModal.department) && <option value={empModal.department}>{empModal.department} (legacy)</option>}
            {DEPTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={empModal.active !== false} onChange={(e) => setEmpModal({ ...empModal, active: e.target.checked })} /> Active</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setEmpModal(null)}>Cancel</Btn><Btn onClick={saveEmp} data-testid="save-employee-btn">Save</Btn></div>
        </div>}
      </Modal>
      </>
      )}
      <Modal open={!!historyEmployee} onClose={() => setHistoryEmployee(null)} title={`Past balances & cuts — ${historyEmployee?.name || ""}`} wide>
        {historyEmployee && <div className="space-y-4">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            <strong>Current outstanding balance: {fmtMoney(salaryReport?.employees.find((employee) => employee.employee_id === historyEmployee.employee_id)?.balance ?? historyEmployee.balance)}</strong>
            <p className="mt-1 text-xs">Each advance adds to the amount owed. Each salary cut subtracts from it. The balance carries over automatically into the next week.</p>
          </div>
          {historyEmployee.balance_history?.length ? <div className="max-h-[55vh] overflow-auto rounded-lg border border-border">
            <table className="w-full min-w-[650px] text-sm">
              <thead className="sticky top-0 bg-slate-100 text-left text-xs text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Entry</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Owed before</th><th className="px-3 py-2 text-right">Owed after</th><th className="px-3 py-2">Notes</th></tr></thead>
              <tbody>{historyEmployee.balance_history.map((entry) => <tr key={`${entry.type}-${entry.id}`} className="border-t border-border/70">
                <td className="px-3 py-2"><span className="block font-semibold">{entry.date || "—"}</span>{entry.type === "cut" && <span className="text-xs text-slate-400">Week {entry.start_date} – {entry.end_date}</span>}</td>
                <td className="px-3 py-2"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${entry.type === "cut" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>{entry.type === "cut" ? <Wallet size={12} /> : <Landmark size={12} />}{entry.type === "cut" ? "Salary cut" : "Money borrowed"}</span></td>
                <td className="px-3 py-2 text-right font-mono">{fmtMoney(entry.amount)}</td><td className="px-3 py-2 text-right font-mono">{fmtMoney(entry.balance_before)}</td><td className="px-3 py-2 text-right font-mono font-semibold">{fmtMoney(entry.balance_after)}</td><td className="px-3 py-2">{entry.notes || "—"}</td>
              </tr>)}</tbody>
            </table>
          </div> : <Empty icon={History} title="No past balances or cuts" hint="Any money borrowed or deducted will appear here." />}
          <div className="flex justify-end border-t border-border pt-3">
            <Btn variant="danger" disabled={historyClearing || !historyEmployee.balance_history?.length} onClick={clearSalaryHistory} data-testid={`clear-salary-history-${historyEmployee.employee_id}`}>
              {historyClearing ? "Clearing history…" : "Clear history"}
            </Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={!!advanceModal} onClose={() => setAdvanceModal(null)} title={`Add balance — ${advanceModal?.employee_name || ""}`}>
        {advanceModal && <div className="space-y-4">
          <Input label="Amount borrowed (R)" type="number" min="0.01" step="0.01" value={advanceModal.amount} onChange={(event) => setAdvanceModal({ ...advanceModal, amount: event.target.value })} data-testid="salary-advance-amount" />
          <Input label="Date" type="date" value={advanceModal.date} onChange={(event) => setAdvanceModal({ ...advanceModal, date: event.target.value })} />
          <Input label="Notes" value={advanceModal.notes} onChange={(event) => setAdvanceModal({ ...advanceModal, notes: event.target.value })} />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setAdvanceModal(null)}>Cancel</Btn><Btn onClick={saveAdvance} data-testid="save-salary-advance">Save advance</Btn></div>
        </div>}
      </Modal>
    </div>
  );
}
