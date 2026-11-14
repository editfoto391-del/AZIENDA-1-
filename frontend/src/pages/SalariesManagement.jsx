import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BadgeCheck, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  Download, History, Search, SlidersHorizontal, Trash2, Wallet,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtMoney, today } from "@/lib/format";
import { isPieceworkTailor, moneyToCents, sumPayrollRows } from "@/lib/salaryReportMath.mjs";
import { Badge, Btn, Card, Empty, Input, Modal, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";

const mondayOf = (value) => {
  const date = new Date(String(value || today()) + "T00:00:00Z");
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
};

const weekRange = (start) => {
  const monday = new Date(String(start || "") + "T00:00:00Z");
  if (!Number.isFinite(monday.getTime()) || monday.getUTCDay() !== 1) return null;
  const saturday = new Date(monday);
  saturday.setUTCDate(saturday.getUTCDate() + 5);
  return { start: monday.toISOString().slice(0, 10), end: saturday.toISOString().slice(0, 10) };
};

const monthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) return null;
  const start = new Date(month + "-01T00:00:00Z");
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

const addDays = (value, days) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const shiftMonth = (value, amount) => {
  const date = new Date(String(value || "") + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
};
const isoWeek = (value) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};
const isoWeekYear = (value) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return date.getUTCFullYear();
};
const calendarDays = (month) => {
  const first = new Date(month + "-01T00:00:00Z");
  const offset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
};
const displayDate = (value, options = { day: "2-digit", month: "short" }) =>
  new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" })
    .format(new Date(String(value || "") + "T00:00:00Z"));
const displayMonth = (value) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(String(value || "") + "-01T00:00:00Z"));

const cents = moneyToCents;
const monthlyEmployee = (employee) => employee?.pay_frequency === "monthly_fixed";
const employeeDepartment = (employee) => employee?.department || (employee?.is_general_worker ? "General Worker" : "Other");
const salaryDepartment = (employee) => employee?.is_general_worker ? "General Worker" : employeeDepartment(employee);
const periodKey = (type, start) => type === "monthly" ? "monthly:" + start.slice(0, 7) : "weekly:" + start;

const fetchPeriodPayments = async (period, periodType) => {
  const periods = [{
    period_type: periodType,
    period_start: period.start,
    period_end: period.end,
  }];
  if (periodType === "weekly") {
    const month = monthRange(period.start.slice(0, 7));
    if (month) periods.push({
      period_type: "monthly",
      period_start: month.start,
      period_end: month.end,
    });
  }
  const lists = await Promise.all(periods.map((paymentPeriod) =>
    api.getUncached("/salaries/payments", paymentPeriod),
  ));
  return lists.flat();
};

const calculateReportTotals = (report, monthlyIncluded, periodType) => {
  const includedRows = (report?.employees || [])
    .filter((employee) => !monthlyEmployee(employee)
      || (monthlyIncluded[employee.employee_id] ?? periodType === "monthly"))
    .map((employee) => {
      const grossCents = cents(employee.gross_salary);
      const cutCents = cents(employee.cut);
      return {
        grossCents,
        cutCents,
        netCents: grossCents - cutCents,
      };
    });
  return sumPayrollRows(includedRows);
};

function PayrollEmployeeCard({
  row,
  periodType,
  expanded,
  onToggleExpanded,
  onIncludeChange,
  rateValue,
  onRateChange,
  paymentDate,
  onPaymentDateChange,
  saving,
  onSaveRate,
  onAddAdvance,
  onCutBalance,
  onShowBalanceHistory,
  onMarkPaid,
}) {
  const { employee, payment, monthly, included, grossCents, cutCents, netCents } = row;
  const showPieces = isPieceworkTailor(employee);
  const initials = String(employee.name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const statusLabel = payment ? "Paid" : monthly && periodType !== "monthly"
    ? "Monthly" : !monthly && periodType !== "weekly" ? "Weekly overview" : "Pending";
  const statusClass = payment
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : statusLabel === "Pending"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <article
      className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_3px_14px_rgba(15,23,42,0.035)] transition-shadow hover:shadow-[0_8px_24px_rgba(15,23,42,0.07)] sm:p-5"
      data-testid={"salary-row-" + employee.employee_id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#e7f6f1] text-sm font-bold text-[#26705d]">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-slate-950">{employee.name}</h4>
              {employee.is_general_worker && <Badge cls="border-[#cae8dc] bg-[#eff9f4] text-[#34725c]">General Worker</Badge>}
              <Badge cls={statusClass}>{statusLabel}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-slate-500">
              {salaryDepartment(employee)}
              {employee.is_general_worker && employee.department ? " · " + employee.department : ""}
            </p>
            {employee.salary_rate_missing && <p className="mt-1 text-xs font-medium text-amber-800">Missing configured rate · not payable</p>}
            {employee.active === false && <p className="mt-1 text-xs text-slate-500">Inactive record</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {monthly && <label className="inline-flex shrink-0 items-center gap-2 text-xs font-medium text-slate-600">
            <input type="checkbox" checked={included} onChange={(event) => onIncludeChange(event.target.checked)} />
            Include
          </label>}
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onAddAdvance} disabled={saving}>Add a balance</Btn>
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onCutBalance} disabled={saving}>Cut balance</Btn>
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onShowBalanceHistory} disabled={saving}>Balance cut/add history</Btn>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-y border-slate-100 py-4 sm:grid-cols-5 sm:gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Salary this period</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(grossCents / 100)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Days attended</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-slate-700 sm:text-base">
            {showPieces ? `${employee.piece_days?.length || 0} days` : `${employee.present_days || 0} full · ${employee.half_days || 0} half`} · {Number(employee.overtime_hours || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} {Number(employee.overtime_hours || 0) === 1 ? "hour" : "hours"} overtime
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Balance due</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(employee.balance || 0)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Deductions</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(cutCents / 100)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Take-home salary</p>
          <p className="mt-1 font-mono text-sm font-bold tabular-nums text-slate-950 sm:text-base">{fmtMoney(netCents / 100)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => onToggleExpanded()} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-950" aria-expanded={expanded}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          {expanded ? "Hide payroll breakdown" : "Payroll breakdown"}
        </button>
        {payment
          ? <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800"><BadgeCheck size={14} className="mr-1" /> Paid {payment.payment_date}</Badge>
          : monthly && periodType !== "monthly"
            ? <span className="text-xs text-slate-500">Pay from Monthly view</span>
            : !monthly && periodType !== "weekly"
              ? <span className="text-xs text-slate-500">Pay from Week view</span>
              : <Btn className="min-w-24 rounded-lg !bg-slate-950 px-5 !text-white hover:!bg-slate-800" onClick={onMarkPaid} disabled={saving || !included || !!employee.salary_rate_missing || netCents <= 0}>
                <Check size={15} /> Pay
              </Btn>}
      </div>

      {expanded && <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 xl:grid-cols-3">
        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Payroll breakdown</h5>
            <p className="mt-1 text-xs text-slate-500">How this period’s gross pay was calculated.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Attendance pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.regular_pay || 0)}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Overtime</p><p className="mt-1 font-mono font-semibold">{Number(employee.overtime_hours || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} {Number(employee.overtime_hours || 0) === 1 ? "hour" : "hours"} overtime · {Number(employee.overtime_pay || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} ZAR</p></div>
            {showPieces ? <>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Piecework pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.piece_pay || 0)}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Recorded production</p><p className="mt-1 font-mono font-semibold">{employee.total_pieces || 0} pieces</p></div>
            </> : <>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Working days</p><p className="mt-1 font-mono font-semibold">{employee.present_days || 0} full · {employee.half_days || 0} half</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Hours worked this {periodType === "weekly" ? "week" : "month"} (lunch excluded)</p><p className="mt-1 font-mono font-semibold">{Number(employee.worked_hours ?? (Number(employee.regular_hours || 0) + Number(employee.overtime_hours || 0)))} hours</p></div>
            </>}
          </div>
          {employee.salary_rate_missing && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">No configured {monthly ? "monthly" : "weekly"} salary rate is available. Payroll is shown as R0.00 and cannot be marked paid.</p>}
        </section>

        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Salary &amp; balance</h5>
            <p className="mt-1 text-xs text-slate-500">Deductions are manual; nothing is taken automatically.</p>
          </div>
          <label className="block text-xs font-semibold text-slate-600">
            Configured {monthly ? "monthly" : "weekly"} salary
            <span className="mt-1 flex items-center gap-2">
              <span>R</span>
              <input type="number" min="0.01" step="0.01" value={rateValue} onChange={(event) => onRateChange(event.target.value)} disabled={saving} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm" />
              <Btn className="rounded-lg" disabled={saving} onClick={onSaveRate}>Save</Btn>
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs">
            <div><p className="text-slate-500">Balance at period start</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.balance_before_period || 0)}</p></div>
            <div><p className="text-slate-500">Balance remaining</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.balance ?? employee.balance_after_period ?? 0)}</p></div>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Payment</h5>
            <p className="mt-1 text-xs text-slate-500">Confirm the date and amount paid.</p>
          </div>
          {payment ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-semibold"><BadgeCheck size={16} className="mr-1 inline" /> Payment recorded</p>
            <p className="mt-2">Paid on {payment.payment_date}</p>
            <p className="mt-1 font-mono text-lg font-semibold">{fmtMoney(payment.net_amount)}</p>
            <p className="mt-1 text-xs">This is the amount actually recorded as paid. Attendance and balance cuts recalculate the current take-home salary above, but do not change this payment record.</p>
            <p className="mt-1 text-xs">This record is locked and cannot be paid twice.</p>
          </div> : monthly && periodType !== "monthly"
            ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">This employee can be paid once from the Monthly payroll.</p>
            : !monthly && periodType !== "weekly"
              ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">Record payment from the specific weekly payroll.</p>
              : <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <Input label="Date paid" type="date" value={paymentDate} onChange={(event) => onPaymentDateChange(event.target.value)} disabled={saving} />
                <div><p className="text-xs text-slate-500">Take-home pay</p><p className="font-mono text-lg font-semibold text-slate-950">{fmtMoney(netCents / 100)}</p></div>
              </div>}
        </section>
      </div>}
    </article>
  );
}

export default function SalariesManagement() {
  const { user } = useAuth();
  const [periodType, setPeriodType] = useState("weekly");
  const [weekStart, setWeekStart] = useState(() => mondayOf(today()));
  const [monthValue, setMonthValue] = useState(() => today().slice(0, 7));
  const [report, setReport] = useState(null);
  const [payments, setPayments] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyCompanyId, setHistoryCompanyId] = useState(user?.company_id || "");
  const [view, setView] = useState("payroll");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [expanded, setExpanded] = useState({});
  const [monthlyIncluded, setMonthlyIncluded] = useState({});
  const [cutDrafts, setCutDrafts] = useState({});
  const [rateDrafts, setRateDrafts] = useState({});
  const [paymentDates, setPaymentDates] = useState({});
  const [savingIds, setSavingIds] = useState({});
  const [totalWasRecalculated, setTotalWasRecalculated] = useState(false);
  const [advanceModal, setAdvanceModal] = useState(null);
  const [cutModal, setCutModal] = useState(null);
  const [balanceHistoryModal, setBalanceHistoryModal] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => today().slice(0, 7));
  const [filtersOpen, setFiltersOpen] = useState(false);

  const period = useMemo(
    () => periodType === "monthly" ? monthRange(monthValue) : weekRange(weekStart),
    [periodType, monthValue, weekStart],
  );
  const payrollKey = period ? periodKey(periodType, period.start) : "";
  const calendarGrid = useMemo(() => calendarDays(calendarMonth), [calendarMonth]);
  const selectedSunday = addDays(weekStart, 6);
  const selectedWeekNumber = isoWeek(weekStart);
  const selectedWeekYear = isoWeekYear(weekStart);

  const openCalendar = () => {
    setCalendarMonth(periodType === "weekly" ? weekStart.slice(0, 7) : monthValue);
    setCalendarOpen((current) => !current);
  };
  const selectCalendarDate = (value) => {
    if (periodType === "weekly") setWeekStart(mondayOf(value));
    else setMonthValue(value.slice(0, 7));
    setCalendarOpen(false);
  };

  const reload = async ({ showLoading = true, resetExpanded = true } = {}) => {
    if (!period) {
      toast.error(periodType === "weekly" ? "Choose a Monday for the weekly payroll." : "Choose a valid calendar month.");
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const params = {
        start_date: period.start,
        end_date: period.end,
        include_monthly_salaries: true,
      };
      const [nextReport, nextPayments] = await Promise.all([
        api.getUncached("/salaries", params),
        fetchPeriodPayments(period, periodType),
      ]);
      setReport(nextReport);
      setPayments(nextPayments || []);
      const paidByEmployee = Object.fromEntries((nextPayments || []).map((payment) => [payment.employee_id, payment]));
      setCutDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, String(paidByEmployee[employee.employee_id]?.deduction_amount ?? employee.cut ?? 0),
      ])));
      setRateDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id,
        String(monthlyEmployee(employee) ? (employee.monthly_salary ?? "") : (employee.weekly_salary ?? "")),
      ])));
      setMonthlyIncluded((current) => Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [
          employee.employee_id,
          Object.hasOwn(current, employee.employee_id)
            ? current[employee.employee_id]
            : periodType === "monthly",
        ])));
      if (resetExpanded) setExpanded({});
      return { report: nextReport, payments: nextPayments || [] };
    } catch (error) {
      toast.error(apiError(error));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!period) {
      setReport(null);
      setPayments([]);
      setLoading(false);
      return () => { active = false; };
    }
    setReport(null);
    setPayments([]);
    setMonthlyIncluded({});
    setCutDrafts({});
    setRateDrafts({});
    setPaymentDates({});
    setTotalWasRecalculated(false);
    setAdvanceModal(null);
    setLoading(true);
    const params = {
      start_date: period.start,
      end_date: period.end,
      include_monthly_salaries: true,
    };
    Promise.all([
      api.getUncached("/salaries", params),
      fetchPeriodPayments(period, periodType),
    ]).then(([nextReport, nextPayments]) => {
      if (!active) return;
      setReport(nextReport);
      setPayments(nextPayments || []);
      const paidByEmployee = Object.fromEntries((nextPayments || []).map((payment) => [payment.employee_id, payment]));
      setCutDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, String(paidByEmployee[employee.employee_id]?.deduction_amount ?? employee.cut ?? 0),
      ])));
      setRateDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id,
        String(monthlyEmployee(employee) ? (employee.monthly_salary ?? "") : (employee.weekly_salary ?? "")),
      ])));
      setMonthlyIncluded((current) => Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [
          employee.employee_id,
          Object.hasOwn(current, employee.employee_id)
            ? current[employee.employee_id]
            : periodType === "monthly",
        ])));
      setExpanded({});
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [period?.start, period?.end, periodType, user?.company_id]);

  useEffect(() => {
    if (view !== "history" || (historyLoaded && historyCompanyId === user?.company_id)) return;
    let active = true;
    setHistoryLoading(true);
    api.getUncached("/salaries/payments/history")
      .then((items) => {
        if (active) {
          setHistory(items || []);
          setHistoryLoaded(true);
          setHistoryCompanyId(user?.company_id || "");
        }
      })
      .catch((error) => { if (active) toast.error(apiError(error)); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [view, historyLoaded, historyCompanyId, user?.company_id]);

  const paymentByEmployee = useMemo(
    () => Object.fromEntries((payments || []).map((payment) => [payment.employee_id, payment])),
    [payments],
  );
  const rows = useMemo(() => (report?.employees || []).map((employee) => {
    const monthly = monthlyEmployee(employee);
    const included = !monthly || (monthlyIncluded[employee.employee_id] ?? periodType === "monthly");
    const payment = paymentByEmployee[employee.employee_id] || null;
    const grossCents = cents(employee.gross_salary);
    const cutCents = cents(employee.cut);
    return {
      employee,
      monthly,
      included,
      grossCents,
      cutCents,
      netCents: grossCents - cutCents,
      payment,
    };
  }).sort((a, b) =>
    salaryDepartment(a.employee).localeCompare(salaryDepartment(b.employee))
    || String(a.employee.name || "").localeCompare(String(b.employee.name || "")),
  ), [report, monthlyIncluded, periodType, paymentByEmployee]);

  const reportRows = rows.filter((row) => row.included);
  const totals = sumPayrollRows(reportRows);
  const includedPaidRows = reportRows.filter((row) => row.payment);
  const paidCents = includedPaidRows.reduce((sum, row) => sum + cents(row.payment.net_amount), 0);
  const paidGrossCents = includedPaidRows.reduce((sum, row) => sum + cents(row.payment.gross_amount), 0);
  const departments = [...new Set(rows.map(({ employee }) => salaryDepartment(employee)))]
    .sort((a, b) => a.localeCompare(b));
  const filteredRows = rows.filter(({ employee }) =>
    (department === "" || salaryDepartment(employee) === department)
    && (String(employee.name || "") + " " + String(employee.employee_id || "") + " " + salaryDepartment(employee) + " " + employeeDepartment(employee))
      .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  const changePeriodType = (nextType) => {
    setPeriodType(nextType);
    setView("payroll");
    setSearch("");
    setDepartment("");
  };

  const saveRate = async (employee) => {
    const amount = Number(rateDrafts[employee.employee_id]);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a salary rate greater than zero.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put("/salaries/rates/" + employee.employee_id, monthlyEmployee(employee)
        ? { monthly_salary: amount }
        : { weekly_salary: amount });
      toast.success("Salary rate saved for " + employee.name);
      await reload();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveCut = async (employee, details = cutModal) => {
    if (monthlyEmployee(employee) && periodType !== "monthly") {
      toast.error("Select the complete month to save a monthly balance deduction.");
      return false;
    }
    if (!monthlyEmployee(employee) && periodType !== "weekly") {
      toast.error("Select a Monday–Saturday week to save this employee's deduction.");
      return false;
    }
    const amount = Number(details?.amount ?? cutDrafts[employee.employee_id] ?? employee.cut ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a cut amount greater than zero.");
      return false;
    }
    const currentRate = monthlyEmployee(employee) ? employee.monthly_salary : employee.weekly_salary;
    if (cents(rateDrafts[employee.employee_id]) !== cents(currentRate)) {
      toast.error("Save the salary rate before saving a deduction.");
      return false;
    }
    if (amount > Number(employee.gross_salary || 0)) {
      toast.error("Deduction cannot exceed this employee's gross salary.");
      return false;
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/cuts", {
        employee_id: employee.employee_id,
        start_date: period.start,
        end_date: period.end,
        amount,
        notes: details?.notes || "",
      });
      toast.success("Manual balance deduction saved.");
      setCutDrafts((current) => ({ ...current, [employee.employee_id]: String(amount) }));
      setCutModal(null);
      await reload({ showLoading: false, resetExpanded: false });
      return true;
    } catch (error) {
      toast.error(apiError(error));
      return false;
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveAdvance = async () => {
    if (!advanceModal || !(Number(advanceModal.amount) > 0)) return toast.error("Enter an amount greater than zero.");
    try {
      await api.post("/salaries/advances", {
        ...advanceModal,
        amount: Number(advanceModal.amount),
      });
      toast.success("Borrowed balance added. Previous paid payrolls were not changed.");
      setAdvanceModal(null);
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const clearBalanceHistory = async () => {
    if (!balanceHistoryModal) return;
    const employee = balanceHistoryModal;
    if (!employee.balance_history?.length) return;
    const confirmed = window.confirm(
      "Delete all balance additions and cuts for " + employee.name
      + "? This resets the outstanding balance to zero. The change will be recorded in the audit history.",
    );
    if (!confirmed) return;
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.del("/salaries/history/" + employee.employee_id);
      toast.success("Balance history cleared for " + employee.name);
      const refreshed = await reload({ showLoading: false, resetExpanded: false });
      const updatedEmployee = refreshed?.report?.employees?.find(
        (item) => item.employee_id === employee.employee_id,
      );
      if (updatedEmployee) setBalanceHistoryModal(updatedEmployee);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const markPaid = async (row) => {
    const employee = row.employee;
    if (!row.included) return toast.error("Include this monthly employee in the report before recording payment.");
    if (row.payment) return toast.error("This payroll has already been marked as paid.");
    const currentRate = row.monthly ? employee.monthly_salary : employee.weekly_salary;
    if (cents(rateDrafts[employee.employee_id]) !== cents(currentRate)) {
      return toast.error("Save the salary rate before marking this payroll as paid.");
    }
    if (cents(cutDrafts[employee.employee_id]) !== cents(employee.cut)) {
      return toast.error("Save the balance deduction before marking this payroll as paid.");
    }
    if (row.monthly && periodType !== "monthly") {
      return toast.error("Select the monthly payroll to record this employee's payment.");
    }
    if (!row.monthly && periodType !== "weekly") {
      return toast.error("Weekly employees must be paid from a Monday–Saturday payroll.");
    }
    const paymentDate = paymentDates[employee.employee_id] || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return toast.error("Choose a valid payment date.");
    const label = row.monthly ? "monthly" : "weekly";
    const confirmed = window.confirm(
      "Record " + fmtMoney(row.netCents / 100) + " as paid to " + employee.name
      + " for this " + label + " payroll on " + paymentDate + "? This cannot be recorded twice.",
    );
    if (!confirmed) return;
    const previousGrossCents = totals.grossCents;
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/payments", {
        employee_id: employee.employee_id,
        period_type: periodType,
        period_start: period.start,
        period_end: period.end,
        payment_date: paymentDate,
      });
      toast.success("Payment recorded for " + employee.name);
      setHistoryLoaded(false);
      const refreshed = await reload({ showLoading: false, resetExpanded: false });
      if (refreshed) {
        const recalculatedTotals = calculateReportTotals(
          refreshed.report,
          monthlyIncluded,
          periodType,
        );
        setTotalWasRecalculated(recalculatedTotals.grossCents !== previousGrossCents);
      }
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const downloadReport = async () => {
    if (!period || !report) return toast.error("Load a valid payroll period first.");
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const colWidths = [47, 35, 24, 30, 30, 28, 31, 27];
      const headers = ["EMPLOYEE", "DEPARTMENT", "TYPE", "DAYS / PIECES", "GROSS", "DEDUCTION", "NET PAYABLE", "STATUS"];
      let y = 16;
      const periodTitle = periodType === "monthly" ? "Monthly salary report" : "Weekly salary report";
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(17);
      pdf.setTextColor(27, 48, 39);
      pdf.text(periodTitle, margin, y);
      y += 7;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(92, 102, 94);
      pdf.text("Pay period: " + period.start + " to " + period.end, margin, y);
      pdf.text("Generated: " + today(), pageWidth - margin, y, { align: "right" });
      y += 9;
      const totalsLabels = [
        ["GROSS PAY", fmtMoney(totals.grossCents / 100)],
        ["BALANCE DEDUCTIONS", fmtMoney(totals.cutCents / 100)],
        ["NET PAYABLE", fmtMoney(totals.netCents / 100)],
      ];
      const cardWidth = (pageWidth - margin * 2 - 8) / 3;
      totalsLabels.forEach((metric, index) => {
        const x = margin + index * (cardWidth + 4);
        pdf.setFillColor(index === 2 ? 31 : 246, index === 2 ? 58 : 246, index === 2 ? 46 : 239);
        pdf.roundedRect(x, y, cardWidth, 15, 2, 2, "F");
        pdf.setTextColor(index === 2 ? 255 : 93, index === 2 ? 255 : 101, index === 2 ? 255 : 92);
        pdf.setFontSize(7);
        pdf.setFont("helvetica", "bold");
        pdf.text(metric[0], x + 3, y + 5);
        pdf.setFontSize(10);
        pdf.text(metric[1], x + 3, y + 11.5);
      });
      y += 22;
      const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
      const drawHeader = () => {
        pdf.setFillColor(26, 50, 40);
        pdf.rect(margin, y, tableWidth, 9, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(6.5);
        pdf.setTextColor(255, 255, 255);
        let x = margin;
        headers.forEach((header, index) => {
          pdf.text(header, x + 2, y + 5.8);
          x += colWidths[index];
        });
        y += 9;
      };
      drawHeader();
      for (const row of reportRows) {
        if (y > pageHeight - 12) {
          pdf.addPage("a4", "landscape");
          y = 15;
          drawHeader();
        }
        const employee = row.employee;
        const showPieces = isPieceworkTailor(employee);
        const basis = row.monthly
          ? "Monthly"
          : showPieces
            ? String(employee.total_pieces || 0) + " pieces"
            : String(employee.present_days || 0) + " full / " + String(employee.half_days || 0) + " half";
        const values = [
          employee.name || "Unnamed",
          salaryDepartment(employee),
          row.monthly ? "Monthly" : (showPieces ? "Piecework" : "Weekly"),
          basis,
          fmtMoney(row.grossCents / 100),
          fmtMoney(row.cutCents / 100),
          fmtMoney(row.netCents / 100),
          row.payment ? "PAID " + row.payment.payment_date : "PENDING",
        ];
        pdf.setFillColor(255, 255, 255);
        pdf.rect(margin, y, tableWidth, 8, "F");
        pdf.setDrawColor(222, 224, 218);
        pdf.line(margin, y + 8, margin + tableWidth, y + 8);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(40, 49, 43);
        let x = margin;
        values.forEach((value, index) => {
          pdf.text(String(value).slice(0, 34), x + 2, y + 5.2);
          x += colWidths[index];
        });
        y += 8;
      }
      const keyLabel = payrollKey.replace(":", "-");
      pdf.save("salary-report-" + keyLabel + ".pdf");
      toast.success("Salary report downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : apiError(error));
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-6" data-testid="salary-management">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#39806b]">Payroll Management</p>
          <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Salaries</h2>
          <p className="mt-2 text-sm text-slate-500">Manage employee salaries and payroll periods.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant={view === "payroll" ? "primary" : "outline"} className="rounded-xl" onClick={() => setView("payroll")} data-testid="salary-view-payroll"><Wallet size={15} /> Payroll</Btn>
          <Btn variant={view === "history" ? "primary" : "outline"} className="rounded-xl" onClick={() => setView("history")} data-testid="salary-view-history"><History size={15} /> Payment history</Btn>
          {view === "payroll" && <Btn variant="outline" className="rounded-xl" disabled={loading || !report} onClick={reload} data-testid="salary-refresh"><History size={15} /> Recalculate</Btn>}
          {view === "payroll" && <Btn className="rounded-xl bg-slate-950 text-white hover:bg-slate-800" disabled={loading || !report || !reportRows.length} onClick={downloadReport} data-testid="salary-download-report"><Download size={15} /> Download report</Btn>}
        </div>
      </div>

      {view === "payroll" ? <>
        <section className="relative rounded-3xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_32px_rgba(15,23,42,0.045)] sm:p-6" aria-label="Pay period selector">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="inline-flex w-full rounded-xl bg-slate-100 p-1 sm:w-auto">
              <button type="button" onClick={() => changePeriodType("weekly")} className={"flex-1 rounded-lg px-5 py-2.5 text-xs font-bold tracking-[0.12em] transition-all sm:flex-none " + (periodType === "weekly" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")} data-testid="salary-weekly-mode">Week</button>
              <button type="button" onClick={() => changePeriodType("monthly")} className={"flex-1 rounded-lg px-5 py-2.5 text-xs font-bold tracking-[0.12em] transition-all sm:flex-none " + (periodType === "monthly" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")} data-testid="salary-monthly-mode">Month</button>
            </div>
            <button type="button" onClick={() => periodType === "weekly" ? setWeekStart(mondayOf(today())) : setMonthValue(today().slice(0, 7))} className="rounded-lg px-3 py-2 text-xs font-semibold text-[#34725c] transition-colors hover:bg-[#eff9f4]" data-testid="salary-today">Today</button>
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 sm:mt-6 sm:gap-4">
            <button
              type="button"
              onClick={() => periodType === "weekly" ? setWeekStart(addDays(weekStart, -7)) : setMonthValue(shiftMonth(monthValue, -1))}
              aria-label={periodType === "weekly" ? "Previous week" : "Previous month"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]"
            ><ChevronLeft size={18} /></button>
            <div className="min-w-0 flex-1 text-center sm:flex-none sm:min-w-[280px]">
              <p className="truncate text-lg font-semibold tracking-tight text-slate-950 sm:text-2xl" data-testid="salary-period-label">
                {periodType === "weekly"
                  ? `${displayDate(weekStart)} – ${displayDate(selectedSunday)}`
                  : displayMonth(monthValue)}
              </p>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {periodType === "weekly" ? `Week ${selectedWeekNumber} · ${selectedWeekYear} · Payroll runs Monday–Saturday` : "Full calendar month"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => periodType === "weekly" ? setWeekStart(addDays(weekStart, 7)) : setMonthValue(shiftMonth(monthValue, 1))}
              aria-label={periodType === "weekly" ? "Next week" : "Next month"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]"
            ><ChevronRight size={18} /></button>
            <div className="relative">
              <button type="button" onClick={openCalendar} aria-label="Open calendar" aria-expanded={calendarOpen} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]" data-testid="salary-calendar-toggle"><CalendarDays size={18} /></button>
              {calendarOpen && <div className="absolute right-0 top-12 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.16)]" data-testid="salary-calendar">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setCalendarMonth(shiftMonth(calendarMonth, -1))} aria-label="Previous calendar month" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronLeft size={17} /></button>
                  <h3 className="text-sm font-semibold text-slate-950">{displayMonth(calendarMonth)}</h3>
                  <button type="button" onClick={() => setCalendarMonth(shiftMonth(calendarMonth, 1))} aria-label="Next calendar month" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronRight size={17} /></button>
                </div>
                <div className="mt-3 grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day} className="py-2">{day}</span>)}
                </div>
                <div className="grid grid-cols-7 gap-y-1">
                  {calendarGrid.map((date) => {
                    const inMonth = date.slice(0, 7) === calendarMonth;
                    const inSelectedWeek = periodType === "weekly" && mondayOf(date) === weekStart;
                    const selected = periodType === "weekly" ? inSelectedWeek : date === monthValue + "-01";
                    const isToday = date === today();
                    return <button
                      type="button"
                      key={date}
                      onClick={() => selectCalendarDate(date)}
                      aria-label={displayDate(date, { day: "numeric", month: "long", year: "numeric" })}
                      aria-pressed={selected}
                      className={"relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-xs transition-colors "
                        + (selected ? "bg-[#dff2e9] font-bold text-[#276b56] "
                          : inSelectedWeek ? "rounded-lg bg-[#f0f8f4] text-[#34725c] "
                            : "text-slate-700 hover:bg-slate-100 ")
                        + (!inMonth ? "text-slate-300 " : "")
                        + (isToday && !selected ? "font-bold ring-1 ring-[#8fc8ad] " : "")}
                      data-testid={"salary-calendar-day-" + date}
                    >{Number(date.slice(-2))}</button>;
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
                  <span className="text-[11px] text-slate-500">{periodType === "weekly" ? "Select any date to choose its week" : "Select any date to choose its month"}</span>
                  <button type="button" onClick={() => { selectCalendarDate(today()); setCalendarMonth(today().slice(0, 7)); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#34725c] hover:bg-[#eff9f4]">Today</button>
                </div>
              </div>}
            </div>
          </div>

          {periodType === "weekly" && <div className="mt-5 grid grid-cols-7 gap-1.5 sm:mt-6 sm:gap-2" aria-label="Selected week days">
            {Array.from({ length: 7 }, (_, index) => {
              const date = addDays(weekStart, index);
              return <button type="button" key={date} onClick={() => { setCalendarMonth(date.slice(0, 7)); setCalendarOpen(true); }} className="min-w-0 rounded-xl bg-[#eff8f3] px-1 py-2 text-center transition-colors hover:bg-[#dff2e9] sm:px-2 sm:py-2.5" data-testid={"salary-week-day-" + date}>
                <span className="block text-[9px] font-semibold uppercase tracking-wide text-[#6b8f80] sm:text-[10px]">{displayDate(date, { weekday: "short" })}</span>
                <span className="mt-0.5 block text-xs font-semibold tabular-nums text-[#315d4c] sm:text-sm">{Number(date.slice(-2))}</span>
              </button>;
            })}
          </div>}
        </section>

        <section className="overflow-hidden rounded-3xl bg-[#111312] p-5 text-white shadow-[0_16px_40px_rgba(15,23,42,0.16)] sm:p-7" aria-label="Payroll summary">
          <div className="grid gap-5 sm:grid-cols-3 sm:gap-0">
            <div className="sm:px-5 sm:first:pl-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Total salaries</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{fmtMoney(totals.grossCents / 100)}</p>
              <p className="mt-1 text-xs text-white/45">Net payable {fmtMoney(totals.netCents / 100)}</p>
            </div>
            <div className="border-t border-white/10 pt-5 sm:border-l sm:border-t-0 sm:px-6 sm:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Employees included</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{report ? reportRows.length : "—"}</p>
              <p className="mt-1 text-xs text-white/45">{report ? `of ${rows.length} employees in this report` : "Loading payroll report"}</p>
            </div>
            <div className="border-t border-white/10 pt-5 sm:border-l sm:border-t-0 sm:px-6 sm:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Settled</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{includedPaidRows.length}</p>
              <p className="mt-1 text-xs text-white/45">{fmtMoney(paidGrossCents / 100)} salary · {fmtMoney(paidCents / 100)} net paid</p>
            </div>
          </div>
        </section>

        {totalWasRecalculated && <p role="status" className="text-xs text-amber-800" data-testid="salary-total-recalculated">
          Please recalculate salaries. The total shown before payment was incorrect and has been updated.
        </p>}

        <section className="space-y-4" aria-label="Employee payroll">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-slate-950">Employee payroll</h3>
              <p className="mt-1 text-xs text-slate-500">
                {periodType === "weekly"
                  ? `${displayDate(weekStart)} – ${displayDate(selectedSunday)}`
                  : displayMonth(monthValue)}
                {report ? ` · ${report.employees.length} employees` : ""}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search employee"
                  aria-label="Search employee"
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-800 outline-none transition focus:border-[#9fcfba] focus:ring-4 focus:ring-[#e7f6ef]"
                  data-testid="salary-search"
                />
              </div>
              <div className="relative">
                <button type="button" onClick={() => setFiltersOpen((current) => !current)} aria-expanded={filtersOpen} className={"inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-colors " + (department ? "border-[#b8ddca] bg-[#eff9f4] text-[#34725c]" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")} data-testid="salary-filter-toggle">
                  <SlidersHorizontal size={16} /> Filters{department ? " · 1" : ""}
                </button>
                {filtersOpen && <div className="absolute right-0 top-12 z-20 w-64 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                  <Select label="Department" value={department} onChange={(event) => setDepartment(event.target.value)} data-testid="salary-department">
                    <option value="">All departments</option>
                    {departments.map((item) => <option key={item} value={item}>{item}</option>)}
                  </Select>
                  {department && <button type="button" onClick={() => setDepartment("")} className="mt-3 text-xs font-semibold text-[#34725c] hover:underline">Clear filter</button>}
                </div>}
              </div>
            </div>
          </div>

          {loading
            ? <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">Calculating payroll from saved records…</div>
            : !report ? <Card className="rounded-2xl"><Empty icon={Wallet} title="Choose a valid pay period" hint="Select a week or complete calendar month." /></Card>
              : filteredRows.length === 0 ? <Card className="rounded-2xl"><Empty icon={Search} title="No employees match your search" /></Card>
                : <div className="grid gap-3">
                  {filteredRows.map((row) => {
                    const employee = row.employee;
                    return <PayrollEmployeeCard
                      key={employee.employee_id}
                      row={row}
                      periodType={periodType}
                      expanded={!!expanded[employee.employee_id]}
                      onToggleExpanded={(forceOpen = false) => setExpanded((current) => ({
                        ...current,
                        [employee.employee_id]: forceOpen ? true : !current[employee.employee_id],
                      }))}
                      onIncludeChange={(included) => setMonthlyIncluded((current) => ({ ...current, [employee.employee_id]: included }))}
                      rateValue={rateDrafts[employee.employee_id] ?? ""}
                      onRateChange={(value) => setRateDrafts((current) => ({ ...current, [employee.employee_id]: value }))}
                      paymentDate={paymentDates[employee.employee_id] || today()}
                      onPaymentDateChange={(value) => setPaymentDates((current) => ({ ...current, [employee.employee_id]: value }))}
                      saving={!!savingIds[employee.employee_id]}
                      onSaveRate={() => saveRate(employee)}
                      onAddAdvance={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, amount: "", date: today(), notes: "" })}
                      onCutBalance={() => setCutModal({
                        employee,
                        amount: "",
                        notes: "",
                      })}
                      onShowBalanceHistory={() => setBalanceHistoryModal(employee)}
                      onMarkPaid={() => markPaid(row)}
                    />;
                  })}
                </div>}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
            <span>{reportRows.length} employees included · {includedPaidRows.length} settled</span>
            <span>Attendance and cuts update current payroll; recorded payments stay unchanged.</span>
          </div>
        </section>

      </> : <Card className="overflow-hidden">
        <div className="border-b border-border p-4">
          <h3 className="font-display text-lg font-semibold text-foreground">Payment history</h3>
          <p className="mt-1 text-xs text-muted-foreground">Recorded payments are read-only and remain separate from new borrowed balances.</p>
        </div>
        {historyLoading ? <div className="p-10 text-center text-sm text-muted-foreground">Loading payment history…</div>
          : history.length === 0 ? <Empty icon={History} title="No salary payments recorded yet" hint="Mark a payroll as paid to create the first payment record." />
          : <div className="grid gap-3 p-4 sm:grid-cols-2">
            {history.map((payment) => <article key={payment.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-950">{payment.employee_name}</p>
                  <p className="mt-1 text-xs text-slate-500">{payment.period_type === "monthly" ? "Month " + payment.period_start.slice(0, 7) : payment.period_start + " – " + payment.period_end}</p>
                </div>
                <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">Paid</Badge>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
                <div><p className="text-slate-500">Gross</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.gross_amount)}</p></div>
                <div><p className="text-slate-500">Deduction</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.deduction_amount)}</p></div>
                <div><p className="text-slate-500">Net paid</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.net_amount)}</p></div>
              </div>
              <p className="mt-3 text-[11px] text-slate-500">Paid {payment.payment_date}</p>
            </article>)}
          </div>}
      </Card>}

      <Modal open={!!advanceModal} onClose={() => setAdvanceModal(null)} title={"Add borrowed balance — " + (advanceModal?.employee_name || "")}>
        {advanceModal && <div className="space-y-4">
          <Input label="Amount borrowed (R)" type="number" min="0.01" step="0.01" value={advanceModal.amount} onChange={(event) => setAdvanceModal({ ...advanceModal, amount: event.target.value })} data-testid="salary-advance-amount" />
          <Input label="Date" type="date" value={advanceModal.date} onChange={(event) => setAdvanceModal({ ...advanceModal, date: event.target.value })} />
          <Input label="Notes" value={advanceModal.notes} onChange={(event) => setAdvanceModal({ ...advanceModal, notes: event.target.value })} />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setAdvanceModal(null)}>Cancel</Btn>
            <Btn onClick={saveAdvance}>Save borrowed balance</Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={!!cutModal} onClose={() => setCutModal(null)} title={"Cut balance — " + (cutModal?.employee?.name || "")}>
        {cutModal && <div className="space-y-4">
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Payroll period: {period?.start} – {period?.end}. This cut will be recorded against this period.
          </p>
          <Input
            label="Amount to cut (R)"
            type="number"
            min="0.01"
            step="0.01"
            max={Number(cutModal.employee.gross_salary || 0)}
            value={cutModal.amount}
            onChange={(event) => setCutModal({ ...cutModal, amount: event.target.value })}
            data-testid="salary-cut-amount"
          />
          <Input
            label="Notes"
            value={cutModal.notes}
            onChange={(event) => setCutModal({ ...cutModal, notes: event.target.value })}
            data-testid="salary-cut-notes"
          />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setCutModal(null)}>Cancel</Btn>
            <Btn
              onClick={() => saveCut(cutModal.employee, cutModal)}
              disabled={!!savingIds[cutModal.employee.employee_id]}
              data-testid="salary-cut-save"
            >Save cut</Btn>
          </div>
        </div>}
      </Modal>
      <Modal
        open={!!balanceHistoryModal}
        onClose={() => setBalanceHistoryModal(null)}
        title={"Balance cut/add history — " + (balanceHistoryModal?.name || "")}
      >
        {balanceHistoryModal && <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Current balance due</p>
            <p className="mt-1 font-mono text-lg font-semibold text-slate-950">{fmtMoney(balanceHistoryModal.balance || 0)}</p>
          </div>
          {balanceHistoryModal.balance_history?.length ? (
            <ol className="max-h-[55vh] space-y-3 overflow-y-auto">
              {[...balanceHistoryModal.balance_history].reverse().map((entry) => (
                <li key={entry.type + "-" + entry.id} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">
                      {entry.type === "advance" ? "Borrowed amount added" : "Balance cut"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {entry.type === "advance" ? "Taken" : "Cut"} on {entry.date || "Date unavailable"}
                    </p>
                    {entry.notes && <p className="mt-1 break-words text-xs text-slate-600">{entry.notes}</p>}
                  </div>
                  <strong className={"shrink-0 font-mono " + (entry.type === "advance" ? "text-amber-700" : "text-emerald-700")}>
                    {entry.type === "advance" ? "+" : "−"}{fmtMoney(entry.amount)}
                  </strong>
                </li>
              ))}
            </ol>
          ) : <p className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">No balance additions or cuts recorded yet.</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Btn
              variant="outline"
              className="border-red-200 text-red-700 hover:bg-red-50"
              onClick={clearBalanceHistory}
              disabled={!balanceHistoryModal.balance_history?.length || !!savingIds[balanceHistoryModal.employee_id]}
              data-testid="salary-clear-balance-history"
            ><Trash2 size={14} /> Delete all history</Btn>
            <Btn variant="outline" onClick={() => setBalanceHistoryModal(null)}>Close</Btn>
          </div>
        </div>}
      </Modal>
    </div>
  );
}
