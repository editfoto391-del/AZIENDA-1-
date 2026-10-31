import { useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarDays, Download, Printer, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import { downloadDailyReportPdf } from "@/lib/dailyReportPdf";
import { companyDailyReportName, companyProfileName } from "@/lib/company";
import { useAuth } from "@/context/AuthContext";
import { Btn } from "@/components/common";

const MIN_ROWS = 12;

function formatMoney(value) {
  return `R ${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ReportSection({ number, title, columns, rows, totalLabel, total, mainInvoiceNo }) {
  const visibleRows = Math.max(MIN_ROWS, rows.length);
  return (
    <section className="daily-report-section" aria-label={title}>
      <div className="daily-report-section-title">
        <span className="daily-report-number">{number}</span>
        <span>{title}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="daily-report-table">
          <thead>
            <tr>{columns.map((column) => <th key={column.key} className={column.align === "right" ? "text-right" : ""}>{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: visibleRows }, (_, index) => {
              const row = rows[index];
              return (
                <tr key={row?.id || `${number}-row-${index}`}>
                  {columns.map((column, columnIndex) => (
                    <td key={column.key} className={column.align === "right" ? "text-right" : ""}>
                      {row ? column.render(row, index) : columnIndex === 0 && number !== "04" ? index + 1 : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className="daily-report-total">
              <td colSpan={columns.length - 1}>{totalLabel}</td>
              <td className="text-right">{formatMoney(total)}</td>
            </tr>
            {number === "01" && (
              <tr className="daily-report-main-invoice">
                <td colSpan={columns.length - 1}>
                  <label className="flex items-center gap-2">
                    <span>Main Invoice No.</span>
                    <span>{mainInvoiceNo || "-"}</span>
                  </label>
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportTables({ report }) {
  return (
    <div className="daily-report-grid">
      <ReportSection
        number="01"
        title="DAILY SENDING INVOICES"
        columns={[
          { key: "no", label: "NO", render: (_row, index) => index + 1 },
          { key: "number", label: "INVOICE NO.", render: (row) => row.number },
          { key: "client", label: "CLIENT / DESCRIPTION", render: (row) => row.client_name },
          { key: "amount", label: "AMOUNT", align: "right", render: (row) => formatMoney(row.amount) },
        ]}
        rows={report.invoices || []}
        totalLabel="Total Sending"
        total={report.totals?.sending}
        mainInvoiceNo={report.main_invoice_no}
      />
      <ReportSection
        number="02"
        title="DAILY RECEIVING / CLIENT PAYMENTS"
        columns={[
          { key: "no", label: "NO", render: (_row, index) => index + 1 },
          { key: "client", label: "CLIENT NAME", render: (row) => row.client_name },
          { key: "invoice", label: "INV. NO.", render: (row) => row.invoice_number },
          { key: "amount", label: "AMOUNT", align: "right", render: (row) => formatMoney(row.amount) },
          { key: "notes", label: "NOTES", render: (row) => row.notes },
        ]}
        rows={report.payments || []}
        totalLabel="Total Received"
        total={report.totals?.received}
      />
      <ReportSection
        number="03"
        title="EXPENSES BREAKDOWN"
        columns={[
          { key: "no", label: "NO", render: (_row, index) => index + 1 },
          { key: "category", label: "CATEGORY", render: (row) => row.category },
          { key: "description", label: "DESCRIPTION", render: (row) => row.description },
          { key: "amount", label: "AMOUNT", align: "right", render: (row) => formatMoney(row.amount) },
        ]}
        rows={report.expenses || []}
        totalLabel="Total Expenses"
        total={report.totals?.expenses}
      />
      <ReportSection
        number="04"
        title="DIESEL USAGE (BY VEHICLE)"
        columns={[
          { key: "vehicle", label: "VEHICLE", render: (row) => row.vehicle },
          { key: "amount", label: "AMOUNT", align: "right", render: (row) => formatMoney(row.amount) },
          { key: "notes", label: "NOTES", render: (row) => row.notes },
        ]}
        rows={report.diesel_usage || []}
        totalLabel="Total Diesel"
        total={report.totals?.diesel}
      />
    </div>
  );
}

const FINANCIAL_SECTIONS = [
  ["invoices", "Invoices", "Invoices by issue date"],
  ["payments", "Payments received", "Collections by payment date"],
  ["pending_payments", "Pending payments", "Outstanding balances on invoices in this period"],
  ["cogs", "Cost of goods sold", "Verified historical batch cost"],
  ["historical_cost_unavailable", "Historical cost unavailable", "Sales not linked to verified batch costs"],
  ["expenses", "Expenses", "Recorded expenses and completed fleet costs"],
  ["buyings", "Buyings", "Purchases shown separately from P&L expenses"],
  ["grvs", "GRV", "Accepted stock receipt value, not automatically an expense"],
];

const MONEY_LABELS = [
  ["total_invoices", "Total invoices", "invoice_count", "invoices"],
  ["payments_received", "Payments received", "payment_count", "payments"],
  ["pending_payments", "Pending payments", null, "pending_payments"],
  ["sales_revenue", "Sales revenue", null, "invoices"],
  ["cogs", "COGS", null, "cogs"],
  ["gross_profit", "Gross profit", null, "profit_reconciliation"],
  ["buyings", "Buyings", "buying_count", "buyings"],
  ["expenses", "Expenses", "expense_count", "expenses"],
  ["grv", "GRV received", "grv_count", "grvs"],
  ["final_profit", "Final profit", null, "profit_reconciliation"],
];

function FinancialReport({ report, mode, onModeChange, category, onCategoryChange, companies, selectedCompany, onCompanyChange, loading }) {
  const [openedSection, setOpenedSection] = useState("");
  const [printing, setPrinting] = useState(false);
  const summary = report?.summary || {};
  const transactions = report?.transactions || {};
  const sectionFilter = category.startsWith("section:") ? category.slice("section:".length) : "";
  const visibleSections = FINANCIAL_SECTIONS.filter(([key]) => (
    category === "all" || sectionFilter === key
    || (!sectionFilter && (transactions[key] || []).some((row) => row.category === category))
  ));
  const transactionCategories = [...new Set(
    Object.values(transactions).flatMap((rows) => (rows || []).map((row) => row.category).filter(Boolean)),
  )].sort();
  const money = (value) => value === null || value === undefined
    ? "Unavailable"
    : formatMoney(value);
  const profitClass = summary.final_profit === null || summary.final_profit === undefined
    ? "text-amber-700"
    : summary.final_profit < 0 ? "text-red-700" : "text-emerald-700";

  const openMetric = (section) => {
    onCategoryChange(section === "profit_reconciliation" ? "all" : `section:${section}`);
    setOpenedSection(section);
    window.setTimeout(() => {
      document.getElementById(`financial-section-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };
  const printReport = () => {
    setPrinting(true);
    window.setTimeout(() => window.print(), 100);
  };
  useEffect(() => {
    const finishPrinting = () => setPrinting(false);
    window.addEventListener("afterprint", finishPrinting);
    return () => window.removeEventListener("afterprint", finishPrinting);
  }, []);

  return (
    <div className="space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-3" data-report-controls>
        {companies.length > 1 && <label className="block min-w-52">
          <span className="mb-1.5 block text-xs font-semibold text-slate-500">Company</span>
          <select value={selectedCompany} onChange={(event) => onCompanyChange(event.target.value)} className="w-full rounded-md border border-input bg-white px-3 py-2.5 text-sm" aria-label="Report company" data-testid="financial-report-company">
            {companies.map((companyId) => <option value={companyId} key={companyId}>{companyProfileName(companyId)}</option>)}
          </select>
        </label>}
        <label className="block min-w-56">
          <span className="mb-1.5 block text-xs font-semibold text-slate-500">Accounting mode</span>
          <select value={mode} onChange={(event) => onModeChange(event.target.value)} className="w-full rounded-md border border-input bg-white px-3 py-2.5 text-sm">
            <option value="expenses_only">Expenses only (excludes COGS)</option>
            <option value="full_production_cost">Full production cost (verified batch costs)</option>
          </select>
        </label>
        <label className="block min-w-52">
          <span className="mb-1.5 block text-xs font-semibold text-slate-500">Transaction category</span>
          <select value={category} onChange={(event) => onCategoryChange(event.target.value)} className="w-full rounded-md border border-input bg-white px-3 py-2.5 text-sm">
            <option value="all">All categories</option>
            {FINANCIAL_SECTIONS.map(([key, title]) => <option value={`section:${key}`} key={`section:${key}`}>{title}</option>)}
            {transactionCategories.map((value) => <option value={value} key={`category:${value}`}>{value}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={printReport} className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50" data-testid="financial-report-print">
            <Printer size={16} /> Print
          </button>
          <button type="button" onClick={printReport} className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-3 py-2.5 text-sm font-semibold text-white hover:bg-slate-700" data-testid="financial-report-pdf">
            <Download size={16} /> Export PDF
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500">Export PDF opens the print dialog; choose “Save as PDF”. The selected company is isolated automatically.</p>

      {report && (
        <div className="financial-report-paper space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">{report.company_name}</p>
              <h2 className="mt-1 text-xl font-bold text-slate-900">{report.period === "weekly" ? "Weekly" : "Monthly"} Financial Report</h2>
              <p className="mt-1 text-sm text-slate-500">{report.start} — {report.end}</p>
            </div>
            <p className="text-xs text-slate-500">Generated {report.generated_at ? new Date(report.generated_at).toLocaleString() : ""}</p>
          </header>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {MONEY_LABELS.map(([key, label, countKey, section]) => (
              <button type="button" key={key} onClick={() => openMetric(section)} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-sky-300 hover:shadow" data-testid={`financial-metric-${key}`}>
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
                <span className={`mt-2 block text-xl font-bold tabular-nums ${key === "final_profit" ? profitClass : "text-slate-900"}`}>{money(summary[key])}</span>
                {countKey && <span className="mt-1 block text-xs text-slate-500">{summary[countKey] || 0} records</span>}
                {key === "final_profit" && <span className="mt-1 block text-xs text-slate-500">{summary.profit_status}</span>}
              </button>
            ))}
          </div>

          {mode === "full_production_cost" && summary.historical_cost_unavailable_count > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
              Historical cost is unavailable for {summary.historical_cost_unavailable_count} invoice(s). Their cost is excluded from verified COGS and final profit; the current stock cost is never substituted.
            </div>
          )}
          <div className="rounded-lg border border-sky-100 bg-sky-50 p-3 text-xs leading-5 text-sky-900">
            {report.accounting_notes?.map((note) => <p key={note}>{note}</p>)}
          </div>

          {visibleSections.map(([key, title, description]) => {
            const rows = transactions[key] || [];
            const visibleRows = category === "all" || sectionFilter === key
              ? rows
              : rows.filter((row) => row.category === category);
            const isOpened = openedSection === key;
            const valueKey = key === "invoices" ? "total_invoices"
              : key === "payments" ? "payments_received"
                : key === "pending_payments" ? "pending_payments"
                  : key === "cogs" ? "cogs"
                    : key === "expenses" ? "expenses"
                      : key === "buyings" ? "buyings"
                        : key === "grvs" ? "grv" : null;
            return (
              <section id={`financial-section-${key}`} className="overflow-hidden rounded-xl border border-slate-200 bg-white" key={key}>
                <button type="button" onClick={() => setOpenedSection(isOpened ? "" : key)} className="flex w-full flex-wrap items-center justify-between gap-2 bg-slate-50 px-4 py-3 text-left hover:bg-slate-100">
                  <span><span className="font-semibold text-slate-800">{title}</span><span className="ml-2 text-xs text-slate-500">{description}</span></span>
                  <span className="font-semibold tabular-nums text-slate-800">{valueKey ? money(summary[valueKey]) : `${rows.length} records`}</span>
                </button>
                {(isOpened || printing) && <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-left text-sm">
                    <thead className="border-y border-slate-200 bg-white text-xs uppercase text-slate-500">
                      <tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Description / party</th><th className="px-3 py-2">Category / status</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Record</th></tr>
                    </thead>
                    <tbody>
                      {visibleRows.length === 0 ? <tr><td colSpan="6" className="px-3 py-5 text-center text-slate-400">No records in this period.</td></tr> : visibleRows.map((row, index) => (
                        <tr className="border-b border-slate-100 align-top" key={row.id || `${key}-${index}`}>
                          <td className="whitespace-nowrap px-3 py-2">{String(row.date || "").slice(0, 10)}</td>
                          <td className="px-3 py-2">{row.description || row.customer_name || row.supplier || row.number || row.grv_number || "—"}{row.supplier && row.description ? <span className="block text-xs text-slate-500">{row.supplier}</span> : null}</td>
                          <td className="px-3 py-2">{row.status || row.category || row.method || "—"}</td>
                          <td className="px-3 py-2">{row.reference || row.number || row.invoice_number || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{row.amount === undefined ? "—" : formatMoney(row.amount)}</td>
                          <td className="px-3 py-2"><details><summary className="cursor-pointer text-xs font-semibold text-sky-700">Details</summary><pre className="mt-2 max-h-64 max-w-xl overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-[10px]">{JSON.stringify(row.source_record || row, null, 2)}</pre></details></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
              </section>
            );
          })}
          <section id="financial-section-profit_reconciliation" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <button type="button" onClick={() => setOpenedSection(openedSection === "profit_reconciliation" ? "" : "profit_reconciliation")} className="w-full bg-slate-50 px-4 py-3 text-left font-semibold text-slate-800 hover:bg-slate-100">Profit reconciliation · {money(summary.final_profit)}</button>
            {(openedSection === "profit_reconciliation" || printing) && <div className="divide-y divide-slate-100 px-4 text-sm">
              <div className="flex justify-between py-2"><span>Accrual sales revenue</span><span>{formatMoney(summary.sales_revenue)}</span></div>
              <div className="flex justify-between py-2"><span>Verified historical COGS</span><span>{money(summary.cogs)}</span></div>
              <div className="flex justify-between py-2"><span>Eligible recorded expenses</span><span>− {formatMoney(summary.expenses)}</span></div>
              <div className="flex justify-between py-2 text-xs text-slate-500"><span>Buyings and GRV inventory movement</span><span>Shown separately, not deducted twice</span></div>
              <div className="flex justify-between py-3 font-bold"><span>Final profit</span><span className={profitClass}>{money(summary.final_profit)}</span></div>
              <p className="pb-3 text-xs text-slate-500">{summary.profit_status}</p>
            </div>}
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <h3 className="px-4 py-3 font-semibold text-slate-800">Daily breakdown</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Payments</th><th className="px-3 py-2 text-right">Expenses</th><th className="px-3 py-2 text-right">Buyings</th><th className="px-3 py-2 text-right">GRV</th><th className="px-3 py-2 text-right">Daily profit</th></tr></thead>
                <tbody>{(report.daily || []).map((day) => <tr key={day.date} className="border-t border-slate-100"><td className="px-3 py-2">{day.date}</td><td className="px-3 py-2 text-right">{formatMoney(day.sales_revenue)} <span className="text-xs text-slate-400">({day.invoice_count})</span></td><td className="px-3 py-2 text-right">{formatMoney(day.payments_received)} <span className="text-xs text-slate-400">({day.payment_count})</span></td><td className="px-3 py-2 text-right">{formatMoney(day.expenses)}</td><td className="px-3 py-2 text-right">{formatMoney(day.buyings)}</td><td className="px-3 py-2 text-right">{formatMoney(day.grv)}</td><td className="px-3 py-2 text-right font-semibold">{money(day.final_profit)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          {report.previous_period && <p className="text-xs text-slate-500">Previous period ({report.previous_period.start} — {report.previous_period.end}): sales {formatMoney(report.previous_period.summary.sales_revenue)}, payments {formatMoney(report.previous_period.summary.payments_received)}, expenses {formatMoney(report.previous_period.summary.expenses)}, final profit {money(report.previous_period.summary.final_profit)}.</p>}
        </div>
      )}
    </div>
  );
}

export default function DailyReport() {
  const { user } = useAuth();
  const [viewMode, setViewMode] = useState("daily");
  const [reportDate, setReportDate] = useState(today());
  const [weekDate, setWeekDate] = useState(today());
  const [monthValue, setMonthValue] = useState(today().slice(0, 7));
  const [accountingMode, setAccountingMode] = useState("expenses_only");
  const [transactionCategory, setTransactionCategory] = useState("all");
  const [reportCompany, setReportCompany] = useState(user?.company_id || "");
  const [report, setReport] = useState(null);
  const [financialReport, setFinancialReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [financialLoading, setFinancialLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const followToday = useRef(true);
  const companyName = report?.company_name || companyDailyReportName(user?.company_id);
  const accessibleCompanies = Array.isArray(user?.company_ids) && user.company_ids.length
    ? user.company_ids
    : [user?.company_id].filter(Boolean);

  useEffect(() => {
    if (!accessibleCompanies.includes(reportCompany)) {
      setReportCompany(user?.company_id || accessibleCompanies[0] || "");
    }
  }, [reportCompany, user?.company_id, user?.company_ids]);

  useEffect(() => {
    if (viewMode !== "daily") return undefined;
    let active = true;
    let firstLoad = true;
    let latestRequest = 0;
    const loadReport = async () => {
      const requestId = ++latestRequest;
      if (firstLoad && active) {
        setLoading(true);
        setReport(null);
        setError("");
      }
      try {
        const data = await api.get("/daily-report", { report_date: reportDate, refresh: Date.now() });
        if (!active || requestId !== latestRequest) return;
        setReport(data);
        setError("");
      } catch (requestError) {
        if (active && requestId === latestRequest) setError(apiError(requestError));
      } finally {
        if (active && firstLoad) setLoading(false);
        firstLoad = false;
      }
    };

    const refreshOnChange = () => { loadReport(); };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") loadReport();
    };
    loadReport();
    const interval = window.setInterval(() => {
      if (followToday.current && reportDate !== today()) {
        setReportDate(today());
        return;
      }
      loadReport();
    }, 20000);
    window.addEventListener("erp:data-changed", refreshOnChange);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("erp:data-changed", refreshOnChange);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reportDate, viewMode]);

  const financialValue = viewMode === "monthly" ? monthValue : weekDate;
  useEffect(() => {
    if (viewMode === "daily") return undefined;
    let active = true;
    const loadFinancialReport = async (clearReport = false) => {
      setFinancialLoading(true);
      if (clearReport) {
        setFinancialReport(null);
        setError("");
      }
      try {
        const data = await api.get("/reports/financial", {
          period: viewMode, value: financialValue, mode: accountingMode,
          company_id: reportCompany, refresh: Date.now(),
        });
        if (active) {
          setFinancialReport(data);
          setError("");
        }
      } catch (requestError) {
        if (active) setError(apiError(requestError));
      } finally {
        if (active) setFinancialLoading(false);
      }
    };
    loadFinancialReport(true);
    const refresh = () => loadFinancialReport();
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") loadFinancialReport();
    };
    const interval = window.setInterval(refresh, 20000);
    window.addEventListener("erp:data-changed", refresh);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("erp:data-changed", refresh);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [viewMode, financialValue, accountingMode, reportCompany]);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadDailyReportPdf(report, report.main_invoice_no);
    } catch (pdfError) {
      toast.error(apiError(pdfError));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{viewMode === "daily" ? "Daily Report" : `${viewMode === "weekly" ? "Weekly" : "Monthly"} Financial Report`}</h1>
          <p className="mt-1 text-sm text-slate-500">{viewMode === "daily" ? companyName : companyProfileName(reportCompany)} {viewMode === "daily" ? "daily transaction summary" : "company-scoped financial summary"}</p>
        </div>
      </div>
      <nav className="flex gap-2 border-b border-slate-200 pb-2" aria-label="Report period">
        {["daily", "weekly", "monthly"].map((period) => <button type="button" key={period} onClick={() => setViewMode(period)} className={`rounded-md px-3 py-2 text-sm font-semibold capitalize ${viewMode === period ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"}`} data-testid={`report-period-${period}`}>{period}</button>)}
      </nav>
      <div className="flex flex-wrap items-end gap-2" data-report-controls>
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500"><CalendarDays size={14} /> {viewMode === "daily" ? "Report date" : viewMode === "weekly" ? "Select a date in the week" : "Report month"}</span>
          <input
            type={viewMode === "monthly" ? "month" : "date"}
            aria-label={viewMode === "monthly" ? "Report month" : "Report date"}
            value={viewMode === "daily" ? reportDate : viewMode === "weekly" ? weekDate : monthValue}
            onChange={(event) => {
              const selected = event.target.value || (viewMode === "monthly" ? today().slice(0, 7) : today());
              if (viewMode === "daily") {
                followToday.current = selected === today();
                setReportDate(selected);
              } else if (viewMode === "weekly") setWeekDate(selected);
              else setMonthValue(selected);
            }}
            className="rounded-md border border-input bg-white px-3 py-2.5 text-sm text-slate-800"
          />
        </label>
        {viewMode === "daily" && <Btn onClick={downloadPdf} disabled={!report || loading || downloading} data-testid="daily-report-download-pdf">
          {downloading ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
          {downloading ? "Preparing PDF..." : "DOWNLOAD PDF"}
        </Btn>}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle size={17} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {viewMode === "daily" && report?.unassigned_fuel_expenses?.length > 0 && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {report.unassigned_fuel_expenses.length} fuel/diesel expense{report.unassigned_fuel_expenses.length === 1 ? "" : "s"} ha{report.unassigned_fuel_expenses.length === 1 ? "s" : "n"} no vehicle assigned. Their amounts are included in Diesel Usage and Total Diesel; assign the correct vehicle in <Link className="font-semibold underline" to="/expenses">Expenses</Link>.
          <ul className="mt-1 list-inside list-disc text-xs">
            {report.unassigned_fuel_expenses.map((expense, index) => (
              <li key={`${expense.description}-${index}`}>{expense.description || "Fuel expense"} — {formatMoney(expense.amount)}</li>
            ))}
          </ul>
        </div>
      )}
      {viewMode === "daily" && report?.pending_invoices?.length > 0 && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {report.pending_invoices.length} invoice draft{report.pending_invoices.length === 1 ? "" : "s"} recorded on this date do not yet have an invoice number, so they are not counted as sent invoices.
          <ul className="mt-1 list-inside list-disc text-xs">
            {report.pending_invoices.map((invoice) => (
              <li key={invoice.id}>{invoice.client_name || "Client not set"} — {formatMoney(invoice.amount)}</li>
            ))}
          </ul>
        </div>
      )}

      {viewMode === "daily" && <div className="daily-report-paper" aria-busy={loading}>
        <header className="daily-report-heading">
          <div className="daily-report-company">{companyName}</div>
          <div className="daily-report-title">DAILY REPORT</div>
          <div className="daily-report-meta">
            <span><strong>Date:</strong> {reportDate}</span>
            <span><strong>Day:</strong> {report?.day || ""}</span>
            <span><strong>Company:</strong> {companyName}</span>
          </div>
        </header>
        {loading ? (
          <div role="status" className="daily-report-loading">Loading report...</div>
        ) : report ? (
          <ReportTables report={report} />
        ) : (
          <div role="status" className="daily-report-loading">Report data could not be loaded.</div>
        )}
      </div>}
      {viewMode !== "daily" && <FinancialReport
        report={financialReport}
        mode={accountingMode}
        onModeChange={setAccountingMode}
        category={transactionCategory}
        onCategoryChange={setTransactionCategory}
        companies={accessibleCompanies}
        selectedCompany={reportCompany}
        onCompanyChange={setReportCompany}
        loading={financialLoading}
      />}
    </div>
  );
}
