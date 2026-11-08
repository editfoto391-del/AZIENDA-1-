import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BadgeCheck, Banknote, Check, ChevronDown, ChevronRight,
  Download, History, Landmark, ListFilter, Search, Wallet,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtMoney, today } from "@/lib/format";
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

const cents = (value) => Math.round((Number(value) || 0) * 100);
const monthlyEmployee = (employee) => employee?.pay_frequency === "monthly_fixed";
const periodKey = (type, start) => type === "monthly" ? "monthly:" + start.slice(0, 7) : "weekly:" + start;

function SummaryMetric({ label, value, icon: Icon, emphasis = false, helper }) {
  return (
    <Card className={"p-4 " + (emphasis ? "border-primary/30 bg-primary text-primary-foreground" : "")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={"text-[11px] font-semibold uppercase tracking-[0.12em] " + (emphasis ? "text-primary-foreground/70" : "text-muted-foreground")}>{label}</p>
          <p className={"mt-2 font-mono text-2xl font-semibold tabular-nums " + (emphasis ? "text-primary-foreground" : "text-foreground")}>{value}</p>
          {helper && <p className={"mt-1 text-xs " + (emphasis ? "text-primary-foreground/70" : "text-muted-foreground")}>{helper}</p>}
        </div>
        <span className={"rounded-lg p-2 " + (emphasis ? "bg-white/10 text-primary-foreground" : "bg-secondary text-primary")}>
          <Icon size={19} />
        </span>
      </div>
    </Card>
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
  const [advanceModal, setAdvanceModal] = useState(null);

  const period = useMemo(
    () => periodType === "monthly" ? monthRange(monthValue) : weekRange(weekStart),
    [periodType, monthValue, weekStart],
  );
  const payrollKey = period ? periodKey(periodType, period.start) : "";

  const reload = async () => {
    if (!period) {
      toast.error(periodType === "weekly" ? "Choose a Monday for the weekly payroll." : "Choose a valid calendar month.");
      return;
    }
    setLoading(true);
    try {
      const params = {
        start_date: period.start,
        end_date: period.end,
        include_monthly_salaries: true,
      };
      const paymentParams = {
        period_type: periodType,
        period_start: period.start,
        period_end: period.end,
      };
      const [nextReport, nextPayments] = await Promise.all([
        api.getUncached("/salaries", params),
        api.getUncached("/salaries/payments", paymentParams),
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
      setMonthlyIncluded(Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [employee.employee_id, periodType === "monthly"])));
      setExpanded({});
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setLoading(false);
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
    setAdvanceModal(null);
    setLoading(true);
    const params = {
      start_date: period.start,
      end_date: period.end,
      include_monthly_salaries: true,
    };
    const paymentParams = {
      period_type: periodType,
      period_start: period.start,
      period_end: period.end,
    };
    Promise.all([
      api.getUncached("/salaries", params),
      api.getUncached("/salaries/payments", paymentParams),
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
      setMonthlyIncluded(Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [employee.employee_id, periodType === "monthly"])));
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
    const grossCents = cents(payment ? payment.gross_amount : employee.gross_salary);
    const cutCents = cents(payment ? payment.deduction_amount : employee.cut);
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
    String(a.employee.department || "Other").localeCompare(String(b.employee.department || "Other"))
    || String(a.employee.name || "").localeCompare(String(b.employee.name || "")),
  ), [report, monthlyIncluded, periodType, paymentByEmployee]);

  const reportRows = rows.filter((row) => row.included);
  const totals = reportRows.reduce((result, row) => ({
    grossCents: result.grossCents + row.grossCents,
    cutCents: result.cutCents + row.cutCents,
    netCents: result.netCents + row.netCents,
  }), { grossCents: 0, cutCents: 0, netCents: 0 });
  const paidCents = payments.reduce((sum, payment) => sum + cents(payment.net_amount), 0);
  const departments = [...new Set(rows.map(({ employee }) => employee.department || "Other"))]
    .sort((a, b) => a.localeCompare(b));
  const filteredRows = rows.filter(({ employee }) =>
    (department === "" || (employee.department || "Other") === department)
    && (String(employee.name || "") + " " + String(employee.department || ""))
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

  const saveCut = async (employee) => {
    if (monthlyEmployee(employee) && periodType !== "monthly") {
      return toast.error("Select the complete month to save a monthly balance deduction.");
    }
    if (!monthlyEmployee(employee) && periodType !== "weekly") {
      return toast.error("Select a Monday–Saturday week to save this employee's deduction.");
    }
    const amount = Number(cutDrafts[employee.employee_id] ?? employee.cut ?? 0);
    if (!Number.isFinite(amount) || amount < 0) return toast.error("Deduction must be zero or more.");
    const currentRate = monthlyEmployee(employee) ? employee.monthly_salary : employee.weekly_salary;
    if (cents(rateDrafts[employee.employee_id]) !== cents(currentRate)) {
      return toast.error("Save the salary rate before saving a deduction.");
    }
    if (amount > Number(employee.available_balance || 0)) {
      return toast.error("Deduction cannot exceed the available borrowed balance.");
    }
    if (amount > Number(employee.gross_salary || 0)) {
      return toast.error("Deduction cannot exceed this employee's gross salary.");
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/cuts", {
        employee_id: employee.employee_id,
        start_date: period.start,
        end_date: period.end,
        amount,
      });
      toast.success("Manual balance deduction saved.");
      await reload();
    } catch (error) {
      toast.error(apiError(error));
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
      await reload();
    } catch (error) {
      toast.error(apiError(error));
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
      await reload();
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
        const basis = row.monthly
          ? "Monthly"
          : employee.pay_type === "piece"
            ? String(employee.total_pieces || 0) + " pieces"
            : String(employee.present_days || 0) + " full / " + String(employee.half_days || 0) + " half";
        const values = [
          employee.name || "Unnamed",
          employee.department || "Other",
          row.monthly ? "Monthly" : (employee.pay_type === "piece" ? "Piecework" : "Weekly"),
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
    <div className="space-y-5" data-testid="salary-management">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Finance &amp; team</p>
          <h2 className="mt-1 font-display text-2xl font-semibold text-foreground sm:text-3xl">Payroll Overview</h2>
          <p className="mt-1 text-sm text-muted-foreground">A clear, auditable view of every salary and payment.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant={view === "payroll" ? "primary" : "outline"} onClick={() => setView("payroll")} data-testid="salary-view-payroll"><Wallet size={15} /> Payroll</Btn>
          <Btn variant={view === "history" ? "primary" : "outline"} onClick={() => setView("history")} data-testid="salary-view-history"><History size={15} /> Payment history</Btn>
        </div>
      </div>

      {view === "payroll" ? <>
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-foreground">Pay period</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {periodType === "weekly" ? "Weekly payroll always covers Monday through Saturday." : "Monthly payroll covers one complete calendar month."}
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-border bg-secondary/70 p-1">
              <button type="button" onClick={() => changePeriodType("weekly")} className={"rounded-md px-3 py-2 text-xs font-semibold transition-colors " + (periodType === "weekly" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground")} data-testid="salary-weekly-mode">Weekly</button>
              <button type="button" onClick={() => changePeriodType("monthly")} className={"rounded-md px-3 py-2 text-xs font-semibold transition-colors " + (periodType === "monthly" ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground")} data-testid="salary-monthly-mode">Monthly</button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {periodType === "weekly" ? <>
              <div className="w-full max-w-xs">
                <Input label="Week starting (Monday)" type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} data-testid="salary-week-start" />
              </div>
              <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5 text-sm">
                <span className="text-muted-foreground">Week ends </span>
                <strong className="font-mono">{period?.end || "Choose a Monday"}</strong>
              </div>
              <Btn variant="outline" onClick={() => setWeekStart(mondayOf(today()))}>This week</Btn>
              <Btn variant="outline" onClick={() => {
                const previous = new Date(mondayOf(today()) + "T00:00:00Z");
                previous.setUTCDate(previous.getUTCDate() - 7);
                setWeekStart(previous.toISOString().slice(0, 10));
              }}>Last week</Btn>
            </> : <>
              <div className="w-full max-w-xs">
                <Input label="Payroll month" type="month" value={monthValue} onChange={(event) => setMonthValue(event.target.value)} data-testid="salary-month-picker" />
              </div>
              <Btn variant="outline" onClick={() => setMonthValue(today().slice(0, 7))}>This month</Btn>
              <Btn variant="outline" onClick={() => {
                const previous = new Date(monthValue + "-01T00:00:00Z");
                previous.setUTCMonth(previous.getUTCMonth() - 1);
                setMonthValue(previous.toISOString().slice(0, 7));
              }}>Previous month</Btn>
            </>}
            <div className="ml-auto flex gap-2">
              <Btn variant="outline" disabled={loading || !report} onClick={reload} data-testid="salary-refresh"><History size={15} /> Recalculate</Btn>
              <Btn disabled={loading || !report || !reportRows.length} onClick={downloadReport} data-testid="salary-download-report"><Download size={15} /> Download report</Btn>
            </div>
          </div>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryMetric label="Employees in report" value={String(reportRows.length)} icon={ListFilter} helper="Monthly employees can be included individually." />
          <SummaryMetric label="Gross payroll" value={fmtMoney(totals.grossCents / 100)} icon={Banknote} />
          <SummaryMetric label="Balance deductions" value={fmtMoney(totals.cutCents / 100)} icon={Landmark} />
          <SummaryMetric label="Net payable" value={fmtMoney(totals.netCents / 100)} icon={Wallet} emphasis helper={"Paid: " + fmtMoney(paidCents / 100) + " · " + payments.length + " recorded payments"} />
        </div>

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-4">
            <div>
              <h3 className="font-display text-lg font-semibold text-foreground">Employee payroll</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {period ? period.start + " – " + period.end : "Select a valid pay period"}
                {report ? " · " + report.employees.length + " employees" : ""}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
              <div className="relative min-w-[210px] flex-1 sm:w-60 sm:flex-none">
                <Search size={15} className="absolute left-3 top-[2.35rem] text-muted-foreground" />
                <Input label="Search employees" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or department" className="pl-9" data-testid="salary-search" />
              </div>
              <div className="min-w-[170px] flex-1 sm:w-48 sm:flex-none">
                <Select label="Department" value={department} onChange={(event) => setDepartment(event.target.value)} data-testid="salary-department">
                  <option value="">All departments</option>
                  {departments.map((item) => <option key={item} value={item}>{item}</option>)}
                </Select>
              </div>
            </div>
          </div>

          {loading ? <div className="p-12 text-center text-sm text-muted-foreground">Calculating payroll from saved records…</div>
            : !report ? <Empty icon={Wallet} title="Choose a valid pay period" hint="Select a Monday–Saturday week or a complete calendar month." />
            : filteredRows.length === 0 ? <Empty icon={Search} title="No employees match your search" />
            : <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[1120px] text-sm">
                  <thead>
                    <tr className="bg-primary text-left text-[10px] font-bold uppercase tracking-[0.12em] text-primary-foreground">
                      <th className="px-3 py-3">Employee</th>
                      <th className="px-3 py-3">Department</th>
                      <th className="px-3 py-3">Pay type</th>
                      <th className="px-3 py-3">Days / pieces</th>
                      <th className="px-3 py-3 text-right">Gross</th>
                      <th className="px-3 py-3 text-right">Deduction</th>
                      <th className="px-3 py-3 text-right">Net payable</th>
                      <th className="px-3 py-3">Report</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const employee = row.employee;
                      const isPaid = !!row.payment;
                      const expandedRow = !!expanded[employee.employee_id];
                      const payLabel = row.monthly ? "Monthly" : employee.pay_type === "piece" ? "Piecework" : "Weekly";
                      const basis = row.monthly
                        ? "Monthly salary"
                        : employee.pay_type === "piece"
                          ? String(employee.total_pieces || 0) + " pieces"
                          : String(employee.present_days || 0) + " full / " + String(employee.half_days || 0) + " half";
                      return <Fragment key={employee.employee_id}>
                        <tr key={employee.employee_id} className="border-b border-border/70 transition-colors hover:bg-secondary/40" data-testid={"salary-row-" + employee.employee_id}>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <button type="button" onClick={() => setExpanded((current) => ({ ...current, [employee.employee_id]: !current[employee.employee_id] }))} aria-label={"Toggle details for " + employee.name} className="rounded p-1 text-muted-foreground hover:bg-secondary">
                                {expandedRow ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              </button>
                              <div>
                                <p className="font-semibold text-foreground">{employee.name}</p>
                                {employee.active === false && <p className="text-[10px] text-muted-foreground">Inactive record</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">{employee.department || "Other"}</td>
                          <td className="px-3 py-3"><Badge cls={row.monthly ? "border-primary/20 bg-primary/10 text-primary" : "border-border bg-secondary text-secondary-foreground"}>{payLabel}</Badge></td>
                          <td className="px-3 py-3 text-muted-foreground">{basis}</td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums">{fmtMoney(row.grossCents / 100)}</td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums">{fmtMoney(row.cutCents / 100)}</td>
                          <td className="px-3 py-3 text-right font-mono font-semibold tabular-nums text-foreground">{fmtMoney(row.netCents / 100)}</td>
                          <td className="px-3 py-3">
                            {row.monthly ? <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input type="checkbox" checked={row.included} onChange={(event) => setMonthlyIncluded((current) => ({ ...current, [employee.employee_id]: event.target.checked }))} data-testid={"salary-include-" + employee.employee_id} />
                              Include
                            </label> : <span className="text-xs text-muted-foreground">Included</span>}
                          </td>
                          <td className="px-3 py-3">
                            {isPaid ? <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800"><Check size={11} className="mr-1" /> Paid</Badge>
                              : row.monthly && periodType !== "monthly" ? <Badge cls="border-border bg-secondary text-secondary-foreground">Monthly</Badge>
                              : !row.monthly && periodType !== "weekly" ? <Badge cls="border-border bg-secondary text-secondary-foreground">Weekly payroll</Badge>
                              : <Badge cls="border-amber-200 bg-amber-50 text-amber-800">Pending</Badge>}
                            {isPaid && <p className="mt-1 text-[10px] text-muted-foreground">{row.payment.payment_date}</p>}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <button type="button" onClick={() => setExpanded((current) => ({ ...current, [employee.employee_id]: !current[employee.employee_id] }))} className="rounded-md border border-border bg-card p-2 text-muted-foreground hover:bg-secondary" aria-label={"Open " + employee.name + " salary details"}>
                              {expandedRow ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                        </tr>
                        {expandedRow && <tr key={employee.employee_id + "-details"} className="border-b border-border bg-secondary/25">
                          <td colSpan={10} className="p-4">
                            <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_1fr]">
                              <section className="space-y-3">
                                <h4 className="font-display font-semibold text-foreground">Calculation details</h4>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                  <div className="rounded-md border border-border bg-card p-3"><p className="text-muted-foreground">Regular pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.regular_pay || 0)}</p></div>
                                  <div className="rounded-md border border-border bg-card p-3"><p className="text-muted-foreground">Overtime · R20/hour</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.overtime_pay || 0)}</p></div>
                                  <div className="rounded-md border border-border bg-card p-3"><p className="text-muted-foreground">Piecework pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.piece_pay || 0)}</p></div>
                                  <div className="rounded-md border border-border bg-card p-3"><p className="text-muted-foreground">Recorded production</p><p className="mt-1 font-mono font-semibold">{employee.total_pieces || 0} pieces</p></div>
                                </div>
                                {employee.piece_weeks?.map((week) => <details key={week.week_start} className="rounded-md border border-border bg-card p-3 text-xs">
                                  <summary className="cursor-pointer font-semibold text-foreground">Piecework {week.week_start} – {week.week_end} · {fmtMoney(week.pay)}</summary>
                                  <div className="mt-2 grid grid-cols-2 gap-2 text-muted-foreground">
                                    <span>Weekday pieces: {week.weekday_pieces}</span>
                                    <span>Saturday pieces: {week.saturday_pieces}</span>
                                    <span>High-rate pieces: {week.high_rate_pieces}</span>
                                    <span>Low-rate pieces: {week.low_rate_pieces}</span>
                                    <span>Recovered: {week.recovered_pieces}</span>
                                    <span>Unrecovered deficit: {week.unrecovered_weekday_deficit}</span>
                                  </div>
                                </details>)}
                              </section>

                              <section className="space-y-3">
                                <h4 className="font-display font-semibold text-foreground">Salary rate &amp; balance</h4>
                                <div className="rounded-md border border-border bg-card p-3">
                                  <label className="block text-xs font-semibold text-muted-foreground">{row.monthly ? "Fixed monthly salary" : "Fixed weekly salary"}
                                    <span className="mt-1 flex items-center gap-2">
                                      <span className="text-muted-foreground">R</span>
                                      <input type="number" min="0.01" step="0.01" value={rateDrafts[employee.employee_id] ?? ""} onChange={(event) => setRateDrafts((current) => ({ ...current, [employee.employee_id]: event.target.value }))} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-2 font-mono text-sm text-foreground" disabled={!!savingIds[employee.employee_id]} />
                                      <Btn size="sm" disabled={!!savingIds[employee.employee_id]} onClick={() => saveRate(employee)}>Save rate</Btn>
                                    </span>
                                  </label>
                                </div>
                                <div className="rounded-md border border-border bg-card p-3">
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div><p className="text-muted-foreground">Balance before</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.balance_before_period || 0)}</p></div>
                                    <div><p className="text-muted-foreground">Current balance</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.balance ?? employee.balance_after_period ?? 0)}</p></div>
                                  </div>
                                  <label className="mt-3 block text-xs font-semibold text-muted-foreground">Manual deduction
                                    <input type="number" min="0" step="0.01" max={Number(employee.available_balance || 0)} value={cutDrafts[employee.employee_id] ?? "0"} onChange={(event) => setCutDrafts((current) => ({ ...current, [employee.employee_id]: event.target.value }))} disabled={!!savingIds[employee.employee_id] || (!!row.payment)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground" />
                                  </label>
                                  {row.monthly && periodType !== "monthly" && <p className="mt-2 text-[11px] text-muted-foreground">Switch to Monthly payroll to edit or save this deduction.</p>}
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Btn size="sm" variant="outline" onClick={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, amount: "", date: today(), notes: "" })} disabled={!!savingIds[employee.employee_id]}> <Landmark size={13} /> Add borrowed balance</Btn>
                                    <Btn size="sm" onClick={() => saveCut(employee)} disabled={!!savingIds[employee.employee_id] || !!row.payment || (row.monthly && periodType !== "monthly") || (!row.monthly && periodType !== "weekly")}>Save deduction</Btn>
                                  </div>
                                </div>
                                {employee.balance_history?.length > 0 && <details className="rounded-md border border-border bg-card p-3 text-xs">
                                  <summary className="cursor-pointer font-semibold text-foreground">Borrowed balance history · {employee.balance_history.length} entries</summary>
                                  <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                                    {employee.balance_history.map((entry) => <div key={entry.type + "-" + entry.id} className="flex justify-between gap-3 border-t border-border pt-2">
                                      <span>{entry.date} · {entry.type === "advance" ? "Borrowed" : "Deduction"} · {entry.notes || "—"}</span>
                                      <strong className="shrink-0 font-mono">{fmtMoney(entry.amount)}</strong>
                                    </div>)}
                                  </div>
                                </details>}
                              </section>

                              <section className="space-y-3">
                                <h4 className="font-display font-semibold text-foreground">Payment</h4>
                                {row.payment ? <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                                  <p className="font-semibold"><BadgeCheck size={16} className="mr-1 inline" /> Payment recorded</p>
                                  <p className="mt-2">Paid on {row.payment.payment_date}</p>
                                  <p className="mt-1 font-mono text-lg font-semibold">{fmtMoney(row.payment.net_amount)}</p>
                                  <p className="mt-1 text-xs">This record is locked and cannot be paid twice.</p>
                                </div> : row.monthly && periodType !== "monthly" ? <div className="rounded-md border border-border bg-card p-4 text-sm">
                                  <p className="font-semibold text-foreground">Monthly salary</p>
                                  <p className="mt-1 text-xs text-muted-foreground">This employee can be paid once from the Monthly payroll. Include or exclude them from this report using the checkbox.</p>
                                </div> : !row.monthly && periodType !== "weekly" ? <div className="rounded-md border border-border bg-card p-4 text-sm">
                                  <p className="font-semibold text-foreground">Weekly earnings overview</p>
                                  <p className="mt-1 text-xs text-muted-foreground">This monthly report summarizes weekly earnings. Record payment from the specific Monday–Saturday week.</p>
                                </div> : <div className="rounded-md border border-border bg-card p-4">
                                  <label className="block text-xs font-semibold text-muted-foreground">Payment date
                                    <input type="date" value={paymentDates[employee.employee_id] || today()} onChange={(event) => setPaymentDates((current) => ({ ...current, [employee.employee_id]: event.target.value }))} disabled={!!savingIds[employee.employee_id]} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" />
                                  </label>
                                  <div className="mt-3 flex items-center justify-between gap-2">
                                    <div><p className="text-xs text-muted-foreground">Net amount to pay</p><p className="font-mono text-xl font-semibold text-primary">{fmtMoney(row.netCents / 100)}</p></div>
                                    <Btn size="sm" className="px-3 py-1.5 text-xs" onClick={() => markPaid(row)} disabled={!!savingIds[employee.employee_id] || !row.included || row.netCents <= 0}><Check size={14} /> Mark as paid</Btn>
                                  </div>
                                </div>}
                              </section>
                            </div>
                          </td>
                        </tr>}
                      </Fragment>;
                    })}
                  </tbody>
                </table>
              </div>

              <div className="divide-y divide-border md:hidden">
                {filteredRows.map((row) => {
                  const employee = row.employee;
                  const isPaid = !!row.payment;
                  const expandedRow = !!expanded[employee.employee_id];
                  return <article key={employee.employee_id} className="p-4" data-testid={"salary-mobile-row-" + employee.employee_id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">{employee.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{employee.department || "Other"} · {row.monthly ? "Monthly" : employee.pay_type === "piece" ? "Piecework" : "Weekly"}</p>
                      </div>
                      {isPaid ? <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">Paid</Badge> : <Badge cls="border-amber-200 bg-amber-50 text-amber-800">{row.monthly ? "Monthly" : periodType === "monthly" ? "Weekly overview" : "Pending"}</Badge>}
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div><p className="text-muted-foreground">Gross</p><p className="mt-1 font-mono font-semibold">{fmtMoney(row.grossCents / 100)}</p></div>
                      <div><p className="text-muted-foreground">Deduction</p><p className="mt-1 font-mono font-semibold">{fmtMoney(row.cutCents / 100)}</p></div>
                      <div><p className="text-muted-foreground">Net</p><p className="mt-1 font-mono font-semibold text-primary">{fmtMoney(row.netCents / 100)}</p></div>
                    </div>
                    {row.monthly && <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input type="checkbox" checked={row.included} onChange={(event) => setMonthlyIncluded((current) => ({ ...current, [employee.employee_id]: event.target.checked }))} />
                      Include in this salary report
                    </label>}
                    <button type="button" onClick={() => setExpanded((current) => ({ ...current, [employee.employee_id]: !current[employee.employee_id] }))} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                      {expandedRow ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {expandedRow ? "Hide details" : "Calculation and payment details"}
                    </button>
                    {expandedRow && <div className="mt-3 space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div><p className="text-muted-foreground">Regular pay</p><strong className="font-mono">{fmtMoney(employee.regular_pay || 0)}</strong></div>
                        <div><p className="text-muted-foreground">Overtime</p><strong className="font-mono">{fmtMoney(employee.overtime_pay || 0)}</strong></div>
                        <div><p className="text-muted-foreground">Piecework</p><strong className="font-mono">{fmtMoney(employee.piece_pay || 0)}</strong></div>
                        <div><p className="text-muted-foreground">Current balance</p><strong className="font-mono">{fmtMoney(employee.balance ?? employee.balance_after_period ?? 0)}</strong></div>
                      </div>
                      <label className="block text-xs font-semibold text-muted-foreground">Manual deduction
                        <input type="number" min="0" step="0.01" value={cutDrafts[employee.employee_id] ?? "0"} onChange={(event) => setCutDrafts((current) => ({ ...current, [employee.employee_id]: event.target.value }))} disabled={!!row.payment || (row.monthly && periodType !== "monthly")} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground" />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Btn size="sm" variant="outline" onClick={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, amount: "", date: today(), notes: "" })}><Landmark size={13} /> Add balance</Btn>
                        <Btn size="sm" onClick={() => saveCut(employee)} disabled={!!row.payment || (row.monthly && periodType !== "monthly") || (!row.monthly && periodType !== "weekly")}>Save deduction</Btn>
                      </div>
                      {row.payment ? <p className="text-xs text-emerald-700">Paid on {row.payment.payment_date} · {fmtMoney(row.payment.net_amount)}</p>
                        : row.monthly && periodType !== "monthly" ? <p className="text-xs text-muted-foreground">Use Monthly payroll to record payment.</p>
                        : !row.monthly && periodType !== "weekly" ? <p className="text-xs text-muted-foreground">Record payment from the specific Monday–Saturday week.</p>
                        : <div className="space-y-2">
                          <Input label="Payment date" type="date" value={paymentDates[employee.employee_id] || today()} onChange={(event) => setPaymentDates((current) => ({ ...current, [employee.employee_id]: event.target.value }))} />
                          <Btn className="w-full" onClick={() => markPaid(row)} disabled={!row.included || row.netCents <= 0}> <Check size={14} /> Mark as paid</Btn>
                        </div>}
                    </div>}
                  </article>;
                })}
              </div>
            </>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
            <span>{reportRows.length} employees included in report · {payments.length} marked paid for this period</span>
            <span>Paid records are snapshots; new borrowed balances carry forward separately.</span>
          </div>
        </Card>
      </> : <Card className="overflow-hidden">
        <div className="border-b border-border p-4">
          <h3 className="font-display text-lg font-semibold text-foreground">Payment history</h3>
          <p className="mt-1 text-xs text-muted-foreground">Recorded payments are read-only and remain separate from new borrowed balances.</p>
        </div>
        {historyLoading ? <div className="p-10 text-center text-sm text-muted-foreground">Loading payment history…</div>
          : history.length === 0 ? <Empty icon={History} title="No salary payments recorded yet" hint="Mark a payroll as paid to create the first payment record." />
          : <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead><tr className="bg-primary text-left text-[10px] font-bold uppercase tracking-[0.12em] text-primary-foreground">
                <th className="px-4 py-3">Payment date</th><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Period</th><th className="px-4 py-3 text-right">Gross</th><th className="px-4 py-3 text-right">Deduction</th><th className="px-4 py-3 text-right">Net paid</th><th className="px-4 py-3">Status</th>
              </tr></thead>
              <tbody>{history.map((payment) => <tr key={payment.id} className="border-b border-border/70 hover:bg-secondary/30">
                <td className="px-4 py-3 font-mono">{payment.payment_date}</td>
                <td className="px-4 py-3 font-semibold">{payment.employee_name}</td>
                <td className="px-4 py-3 text-muted-foreground">{payment.period_type === "monthly" ? "Month " + payment.period_start.slice(0, 7) : payment.period_start + " – " + payment.period_end}</td>
                <td className="px-4 py-3 text-right font-mono">{fmtMoney(payment.gross_amount)}</td>
                <td className="px-4 py-3 text-right font-mono">{fmtMoney(payment.deduction_amount)}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold">{fmtMoney(payment.net_amount)}</td>
                <td className="px-4 py-3"><Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">Paid</Badge></td>
              </tr>)}</tbody>
            </table>
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
    </div>
  );
}
