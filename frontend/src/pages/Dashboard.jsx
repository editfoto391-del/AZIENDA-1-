import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDate, today, STATUS_META } from "@/lib/format";
import { Btn, Card, Badge, Input, Modal, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { dedicatedCompanyDomain } from "@/lib/company";
import {
  Receipt, Wallet, AlertTriangle, Boxes, Plus, UserPlus, CreditCard,
  PackagePlus, Factory, CalendarCheck, Truck, TrendingUp, ArrowRight, Banknote, ClipboardList, LockKeyhole,
  Pencil, Trash2,
  Eye, Copy, RefreshCw, ShieldOff,
} from "lucide-react";

const QUICK = [
  { label: "Create Invoice", icon: Plus, to: "/invoices/new" },
  { label: "Add Customer", icon: UserPlus, to: "/customers?add=1" },
  { label: "Record Payment", icon: CreditCard, to: "/invoices" },
  { label: "Update Stock", icon: PackagePlus, to: "/stock" },
  { label: "Production Record", icon: Factory, to: "/production?add=1" },
  { label: "Record Attendance", icon: CalendarCheck, to: "/attendance" },
  { label: "Create Delivery", icon: Truck, to: "/deliveries?add=1" },
  { label: "Create Order", icon: ClipboardList, to: "/orders" },
  { label: "Record Expense", icon: Banknote, to: "/expenses" },
];

const WORKER_SECTION_OPTIONS = [
  ["customers", "Customers"], ["suppliers", "Suppliers"], ["buyings", "Buyings"],
  ["invoices", "Invoice"], ["orders", "Orders"], ["stock", "Stock"],
  ["production", "Production"], ["attendance", "Attendance"], ["deliveries", "Deliveries"],
  ["fleet", "Fleet"], ["expenses", "Expenses"], ["grv", "GRV"],
  ["daily-report", "Daily Report"], ["client-payments", "Clients payment and balances"],
  ["settings", "Settings"],
];

const currentMonth = today().slice(0, 7);
const previousMonth = (month) => {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthLabel = (value) => new Date(`${value}-01T00:00:00`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

function KPI({ title, value, icon: Icon, tint, onClick, comparison }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div whileHover={reduceMotion ? undefined : { y: -2, scale: 1.01 }} whileTap={reduceMotion ? undefined : { scale: 0.995 }} transition={{ type: "spring", stiffness: 460, damping: 24, mass: 0.6 }}>
      <Card className="premium-card group p-5 cursor-pointer border-l-2 border-l-transparent hover:border-l-primary hover:shadow-md transition-all" onClick={onClick} data-testid={`kpi-${title.toLowerCase().replace(/\s/g, "-")}`}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.13em]">{title}</p>
            <p className="text-2xl font-semibold text-slate-900 mt-2 font-mono tabular-nums">{value}</p>
            {comparison && <p className="mt-1 text-[11px] text-slate-500">{comparison}</p>}
          </div>
          <div className={`h-10 w-10 rounded-md flex items-center justify-center transition-transform group-hover:translate-y-[-2px] ${tint}`}>
            <Icon size={19} strokeWidth={1.8} />
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

function Section({ title, icon: Icon, children, action }) {
  return (
    <motion.div whileHover={{ y: -1 }} transition={{ type: "spring", stiffness: 420, damping: 26, mass: 0.55 }}>
      <Card className="premium-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2 font-display text-lg">
            {Icon && <Icon size={17} strokeWidth={1.8} className="text-primary" />} {title}
          </h3>
          {action}
        </div>
        {children}
      </Card>
    </motion.div>
  );
}

function SkeletonBlock({ className = "" }) {
  return <span className={`dashboard-skeleton-bar block rounded-md ${className}`} aria-hidden="true" />;
}

function DashboardSkeleton() {
  const cards = (count, className = "") => Array.from({ length: count }, (_, index) => (
    <div key={index} className={`luxury-card rounded-lg border border-border bg-white p-5 ${className}`}>
      <SkeletonBlock className="h-2.5 w-24" />
      <SkeletonBlock className="mt-4 h-6 w-32" />
    </div>
  ));

  return (
    <div className="dashboard-loading space-y-6" role="status" aria-live="polite" aria-busy="true" aria-label="Loading dashboard">
      <div className="space-y-3">
        <SkeletonBlock className="h-2.5 w-36" />
        <SkeletonBlock className="h-9 w-64 max-w-full" />
        <SkeletonBlock className="h-3 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">{cards(5)}</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards(4)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{cards(5, "!p-3")}</div>
      <div className="luxury-card rounded-lg border border-border bg-white p-5">
        <SkeletonBlock className="mb-5 h-4 w-32" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex flex-col items-center gap-2 rounded-lg border border-border bg-white/70 p-4">
              <SkeletonBlock className="h-5 w-5 rounded-full" />
              <SkeletonBlock className="h-3 w-20 max-w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">{cards(6)}</div>
    </div>
  );
}

export default function Dashboard() {
  const nav = useNavigate();
  const { user } = useAuth();
  const dedicatedDomain = dedicatedCompanyDomain();
  const [d, setD] = useState(null);
  const [period, setPeriod] = useState("month");
  const [loadingError, setLoadingError] = useState("");
  const [reload, setReload] = useState(0);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareKind, setCompareKind] = useState("month");
  const [firstMonth, setFirstMonth] = useState(previousMonth(currentMonth));
  const [secondMonth, setSecondMonth] = useState(currentMonth);
  const [firstYear, setFirstYear] = useState(String(Number(currentMonth.slice(0, 4)) - 1));
  const [secondYear, setSecondYear] = useState(currentMonth.slice(0, 4));
  const [comparisonResult, setComparisonResult] = useState(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const [workers, setWorkers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [workerCompanyId, setWorkerCompanyId] = useState(user?.company_id || dedicatedDomain?.companyId || "");
  const [workerModalOpen, setWorkerModalOpen] = useState(false);
  const [workerSaving, setWorkerSaving] = useState(false);
  const [workerLinkOpen, setWorkerLinkOpen] = useState(false);
  const [workerLinkInfo, setWorkerLinkInfo] = useState(null);
  const [workerLinkLoading, setWorkerLinkLoading] = useState(false);
  const [workerLinkSaving, setWorkerLinkSaving] = useState(false);
  const [workerDraft, setWorkerDraft] = useState({
    name: "", username: "", email: "", worker_role: "", password: "",
    company_id: user?.company_id || "", allowed_sections: ["invoices"], stock_only: false,
  });

  useEffect(() => {
    if (!user?.is_owner) return;
    api.get("/companies/profiles")
      .then((companyList) => {
        const accessibleCompanies = companyList.filter((company) =>
          user.admin_company_ids?.includes(company.id)
          && (!dedicatedDomain || user.is_worker || company.id === dedicatedDomain.companyId)
        );
        setCompanies(accessibleCompanies);
        setWorkerCompanyId((current) => dedicatedDomain?.companyId || current || user.company_id || accessibleCompanies[0]?.id || "");
      })
      .catch((error) => toast.error(apiError(error)));
  }, [user]);

  useEffect(() => {
    if (!user?.is_owner || !workerCompanyId) return;
    setWorkers([]);
    api.get("/access/workers", { company_id: workerCompanyId })
      .then(setWorkers)
      .catch((error) => toast.error(apiError(error)));
  }, [user, workerCompanyId]);

  useEffect(() => {
    let active = true;
    setD(null);
    setLoadingError("");
    api.get("/dashboard", { period })
      .then((data) => { if (active) setD(data); })
      .catch((error) => { if (active) setLoadingError(apiError(error)); });
    return () => { active = false; };
  }, [period, reload]);

  if (!d && loadingError) return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5" role="alert">
      <p className="font-semibold text-red-800">Dashboard could not be loaded.</p>
      <p className="mt-1 text-sm text-red-700">{loadingError}</p>
      <button onClick={() => setReload((value) => value + 1)} className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100">
        Try again
      </button>
    </div>
  );
  if (!d) return <DashboardSkeleton />;

  const periodProfit = d.period_profit || {};
  const previousProfit = d.previous_period_profit || {};
  const comparison = (value, previous) => {
    const difference = (Number(value) || 0) - (Number(previous) || 0);
    if (difference === 0) return "No change vs previous period";
    return `${fmtMoney(Math.abs(difference))} ${difference > 0 ? "higher" : "lower"} vs previous period`;
  };
  const periodLabels = { today: "Today", week: "This Week", month: "This Month", year: "This Year" };
  const periodLabel = periodLabels[period];
  const periodRange = `${fmtDate(d.period_start)} – ${fmtDate(d.period_end)}`;
  const previousRange = `${fmtDate(d.previous_period_start)} – ${fmtDate(d.previous_period_end)}`;
  const empty = (t) => <p className="text-sm text-slate-400 py-3">{t}</p>;
  const runCustomComparison = async () => {
    const first = compareKind === "month" ? firstMonth : firstYear;
    const second = compareKind === "month" ? secondMonth : secondYear;
    if (first === second) {
      setComparisonError("Choose two different periods to compare.");
      setComparisonResult(null);
      return;
    }
    setComparisonLoading(true);
    setComparisonError("");
    try {
      setComparisonResult(await api.get("/dashboard/compare", { kind: compareKind, first, second }));
    } catch (error) {
      setComparisonError(apiError(error));
      setComparisonResult(null);
    } finally {
      setComparisonLoading(false);
    }
  };
  const compareLabel = (entry, kind) => kind === "month" ? monthLabel(entry.value) : entry.value;
  const comparisonDifference = (a, b) => {
    const delta = (Number(a) || 0) - (Number(b) || 0);
    if (delta === 0) return "No difference";
    return `${delta > 0 ? "+" : "−"}${fmtMoney(Math.abs(delta))}`;
  };
  const saveWorker = async (event) => {
    event.preventDefault();
    if (workerSaving) return;
    setWorkerSaving(true);
    try {
      if (workerDraft.id) {
        const updated = await api.put(`/access/workers/${workerDraft.id}?company_id=${encodeURIComponent(workerDraft.company_id)}`, {
          worker_role: workerDraft.worker_role,
          allowed_sections: workerDraft.allowed_sections,
          stock_only: workerDraft.stock_only,
        });
        setWorkers((current) => current.map((worker) => worker.id === updated.id ? updated : worker));
        toast.success("Worker access updated");
      } else {
        const created = await api.post("/access/workers", workerDraft);
        if (created.company_id === workerCompanyId) setWorkers((current) => [...current, created]);
        toast.success("Worker added");
      }
      setWorkerDraft({
        name: "", username: "", email: "", worker_role: "", password: "",
        company_id: user?.company_id || "", allowed_sections: ["invoices"], stock_only: false,
      });
      setWorkerModalOpen(false);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkerSaving(false);
    }
  };
  const toggleWorkerSection = (section) => setWorkerDraft((current) => ({
    ...current,
    allowed_sections: current.allowed_sections.includes(section)
      ? current.allowed_sections.filter((item) => item !== section)
      : [...current.allowed_sections, section],
  }));
  const activeCompanyName = companies.find((company) => company.id === workerDraft.company_id)?.name || workerDraft.company_id;
  const changeWorkerCompany = async (companyId) => {
    setWorkerDraft((current) => ({ ...current, company_id: companyId }));
  };
  const editWorker = (worker) => {
    setWorkerDraft({
      id: worker.id,
      name: worker.name,
      username: worker.username,
      email: "",
      worker_role: worker.worker_role,
      password: "",
      company_id: worker.company_id,
      allowed_sections: [...new Set((worker.allowed_sections || []).map((section) => section === "costs" ? "grv" : section))],
      stock_only: worker.stock_only === true,
    });
    setWorkerModalOpen(true);
  };
  const deleteWorker = async (worker) => {
    if (!window.confirm(`Permanently remove worker "${worker.name}" and revoke all their sessions? This cannot be undone.`)) return;
    try {
      await api.del(`/access/workers/${worker.id}?company_id=${encodeURIComponent(worker.company_id)}`);
      setWorkers((current) => current.filter((item) => item.id !== worker.id));
      toast.success("Worker permanently removed");
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const workerLinkUrl = (accessToken) =>
    accessToken ? `${window.location.origin}/worker-access/${accessToken}` : "";
  const openWorkerLink = async (worker) => {
    setWorkerLinkOpen(true);
    setWorkerLinkInfo(null);
    setWorkerLinkLoading(true);
    try {
      const params = `?company_id=${encodeURIComponent(worker.company_id)}`;
      let info = await api.getUncached(`/access/workers/${worker.id}/personal-link${params}`);
      if (info.active && !info.link_active) {
        info = await api.post(`/access/workers/${worker.id}/personal-link${params}`, {});
      }
      setWorkerLinkInfo({ ...info, access_url: workerLinkUrl(info.access_token) });
    } catch (error) {
      toast.error(apiError(error));
      setWorkerLinkOpen(false);
    } finally {
      setWorkerLinkLoading(false);
    }
  };
  const regenerateWorkerLink = async () => {
    if (!workerLinkInfo || workerLinkSaving) return;
    setWorkerLinkSaving(true);
    try {
      const params = `?company_id=${encodeURIComponent(workerLinkInfo.company_id)}`;
      const info = await api.post(
        `/access/workers/${workerLinkInfo.id}/personal-link/regenerate${params}`,
        {},
      );
      setWorkerLinkInfo({ ...info, access_url: workerLinkUrl(info.access_token) });
      toast.success("Personal access link regenerated");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkerLinkSaving(false);
    }
  };
  const revokeWorkerLink = async () => {
    if (!workerLinkInfo || workerLinkSaving) return;
    if (!window.confirm(`Revoke access for ${workerLinkInfo.name}? Their active sessions will be ended.`)) return;
    setWorkerLinkSaving(true);
    try {
      const params = `?company_id=${encodeURIComponent(workerLinkInfo.company_id)}`;
      const info = await api.del(`/access/workers/${workerLinkInfo.id}/personal-link${params}`);
      setWorkerLinkInfo({ ...info, access_url: "" });
      setWorkers((current) => current.map((worker) => worker.id === info.id
        ? { ...worker, active: false }
        : worker));
      toast.success("Worker access revoked");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkerLinkSaving(false);
    }
  };
  const copyWorkerLink = async () => {
    if (!workerLinkInfo?.access_url) return;
    try {
      await navigator.clipboard.writeText(workerLinkInfo.access_url);
      toast.success("Personal access link copied");
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div className="dashboard-stagger space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">{user?.name || "Company"} · Operations</p>
        <h1 className="text-3xl sm:text-4xl font-normal text-slate-900 font-display mt-1">Business overview</h1>
        <p className="text-sm text-slate-500 mt-1">Performance, cash flow and daily operations</p>
        </div>
        {user?.is_owner && <Btn onClick={() => { setWorkerDraft({ name: "", username: "", email: "", worker_role: "", password: "", company_id: user?.company_id || "", allowed_sections: ["invoices"], stock_only: false }); setWorkerModalOpen(true); }} data-testid="add-worker-open"><UserPlus size={16} /> Add Worker</Btn>}
      </div>

      {user?.is_owner && <Section title="Workers" icon={UserPlus} action={<div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">Company
          <select value={workerCompanyId} onChange={(event) => setWorkerCompanyId(event.target.value)} className="rounded-md border border-input bg-white px-2 py-1.5 text-sm" data-testid="worker-company-filter">
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <span className="text-xs text-slate-400">{workers.length} workers</span>
      </div>}>
        {workers.length === 0 ? <p className="text-sm text-slate-400">No workers added for this company yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-slate-400">
                <th className="py-2 font-semibold">Worker</th><th className="py-2 font-semibold">Role</th><th className="py-2 font-semibold">Company</th><th className="py-2 font-semibold">Sections</th><th className="py-2 text-right font-semibold">Actions</th>
              </tr></thead>
              <tbody>{workers.map((worker) => (
                <tr key={worker.id} className="border-b border-border/60" data-testid={`worker-row-${worker.id}`}>
                  <td className="py-3"><p className="font-semibold text-slate-800">{worker.name}</p><p className="text-xs text-slate-400">{worker.username}</p></td>
                  <td className="py-3 text-slate-600">{worker.worker_role}</td>
                  <td className="py-3 text-slate-600">{companies.find((company) => company.id === worker.company_id)?.name || worker.company_id}</td>
                  <td className="py-3 text-slate-600">{(worker.allowed_sections || []).map((section) => WORKER_SECTION_OPTIONS.find(([key]) => key === section)?.[1] || section).join(", ")}</td>
                  <td className="py-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => openWorkerLink(worker)} aria-label={`View personal access link for ${worker.name}`} className="rounded p-1.5 text-slate-400 hover:text-primary" data-testid={`worker-link-${worker.id}`}><Eye size={15} /></button>
                    <button type="button" onClick={() => editWorker(worker)} aria-label={`Edit access for ${worker.name}`} className="rounded p-1.5 text-slate-400 hover:text-primary" data-testid={`edit-worker-${worker.id}`}><Pencil size={15} /></button>
                    <button type="button" onClick={() => deleteWorker(worker)} aria-label={`Remove ${worker.name}`} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" data-testid={`delete-worker-${worker.id}`}><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>}

      {user?.is_owner && <Modal open={workerModalOpen} onClose={() => !workerSaving && setWorkerModalOpen(false)} title={workerDraft.id ? "Edit Worker Access" : "Add Worker"} wide>
        <form onSubmit={saveWorker} className="space-y-4" data-testid="add-worker-form">
          <div className="grid gap-3 sm:grid-cols-2">
            {workerDraft.id ? <>
              <Input label="Worker name" value={workerDraft.name} disabled data-testid="worker-name" />
              <Input label="Username" value={workerDraft.username} disabled data-testid="worker-username" />
            </> : <>
              <Input label="Worker name *" value={workerDraft.name} onChange={(event) => setWorkerDraft({ ...workerDraft, name: event.target.value })} required data-testid="worker-name" />
              <Input label="Username *" value={workerDraft.username} onChange={(event) => setWorkerDraft({ ...workerDraft, username: event.target.value })} required data-testid="worker-username" />
            </>}
            <Input label="Role *" placeholder="e.g. Invoice Clerk" value={workerDraft.worker_role} onChange={(event) => setWorkerDraft({ ...workerDraft, worker_role: event.target.value })} required data-testid="worker-role" />
            {!workerDraft.id && <>
              <Input label="Email (optional)" type="email" value={workerDraft.email} onChange={(event) => setWorkerDraft({ ...workerDraft, email: event.target.value })} data-testid="worker-email" />
              <Input label="Initial password *" type="password" minLength={8} value={workerDraft.password} onChange={(event) => setWorkerDraft({ ...workerDraft, password: event.target.value })} required data-testid="worker-password" />
              <Select label="Company" value={workerDraft.company_id || user?.company_id || ""} onChange={(event) => changeWorkerCompany(event.target.value)} data-testid="worker-company">
                {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </Select>
            </>}
          </div>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700">
            <input type="checkbox" checked={workerDraft.stock_only} onChange={(event) => setWorkerDraft((current) => ({
              ...current,
              stock_only: event.target.checked,
              worker_role: event.target.checked ? "Stock Controller" : current.worker_role,
              allowed_sections: event.target.checked ? ["stock"] : current.allowed_sections,
            }))} data-testid="worker-stock-only" />
            <span><span className="block font-semibold">Stock-only sub-user</span><span className="block text-xs text-slate-500">Can access stock only; selling prices are visible, purchase costs are hidden.</span></span>
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-slate-700">Sections this worker can access</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {WORKER_SECTION_OPTIONS.filter(([section]) => !workerDraft.stock_only || section === "stock").map(([section, label]) => (
                <label key={section} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700">
                  <input type="checkbox" checked={workerDraft.allowed_sections.includes(section)} onChange={() => toggleWorkerSection(section)} data-testid={`worker-section-${section}`} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="flex items-center gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-500"><LockKeyhole size={14} /> Workers with Stock access can see selling prices, never purchase costs. Other sections stay locked; the worker starts with Invoice access selected.</p>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => setWorkerModalOpen(false)} disabled={workerSaving}>Cancel</Btn>
            <Btn type="submit" disabled={workerSaving || workerDraft.allowed_sections.length === 0} data-testid="worker-save">{workerSaving ? "Saving..." : workerDraft.id ? "Save Access" : "Add Worker"}</Btn>
          </div>
        </form>
      </Modal>}

      {user?.is_owner && <Modal
        open={workerLinkOpen}
        onClose={() => !workerLinkSaving && setWorkerLinkOpen(false)}
        title="Personal worker access"
      >
        {workerLinkLoading ? <div className="py-8 text-center text-sm text-slate-500" role="status">Preparing secure access link...</div>
          : workerLinkInfo && <div className="space-y-5" data-testid="worker-access-link-dialog">
            <div className="grid gap-3 rounded-xl border border-border/70 bg-white/70 p-4 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Worker</p>
                <p className="mt-1 font-semibold text-slate-800">{workerLinkInfo.name}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Assigned role</p>
                <p className="mt-1 font-semibold text-slate-800">{workerLinkInfo.worker_role}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Assigned company</p>
                <p className="mt-1 font-semibold text-slate-800">{workerLinkInfo.company_name}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Authorized sections</p>
                <p className="mt-1 font-semibold text-slate-800">{(workerLinkInfo.allowed_sections || [])
                  .map((section) => WORKER_SECTION_OPTIONS.find(([key]) => key === section)?.[1] || section)
                  .join(", ")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="worker-personal-access-url" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Personal access link</label>
              {workerLinkInfo.access_url ? <div className="flex gap-2">
                <input id="worker-personal-access-url" readOnly value={workerLinkInfo.access_url} data-testid="worker-personal-access-url"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-slate-50 px-3 py-2.5 text-xs text-slate-700 outline-none" />
                <Btn type="button" onClick={copyWorkerLink} data-testid="worker-copy-access-link"><Copy size={15} /> Copy Link</Btn>
              </div> : <p className="rounded-lg border border-dashed border-border bg-slate-50 px-3 py-3 text-sm text-slate-500">
                {workerLinkInfo.active
                  ? "No personal link exists yet."
                  : "Access is revoked. Generate a new link to restore this worker's access."}
              </p>}
              <p className="text-xs text-slate-500">The link identifies the worker but does not replace their password. Access always follows the current company and section permissions.</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border/70 pt-4">
              {workerLinkInfo.link_active && <Btn type="button" variant="danger" onClick={revokeWorkerLink} disabled={workerLinkSaving} data-testid="worker-revoke-access">
                <ShieldOff size={15} /> Revoke Access
              </Btn>}
              <Btn type="button" variant="outline" onClick={regenerateWorkerLink}
                disabled={workerLinkSaving || !workerLinkInfo.can_regenerate} data-testid="worker-regenerate-access-link">
                <RefreshCw size={15} /> {workerLinkInfo.link_active ? "Regenerate Link" : "Generate Link"}
              </Btn>
            </div>
          </div>}
      </Modal>}

      <section data-testid="dashboard-monthly-summary">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Financial Overview · {periodLabel}</h2>
            <p className="mt-1 text-xs text-slate-500">{periodRange} <span className="text-slate-400">· Previous: {previousRange}</span></p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              Period
              <select value={period} onChange={(event) => setPeriod(event.target.value)} data-testid="dashboard-period-select"
                className="rounded-lg border border-border bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15">
                {Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <button onClick={() => setCompareOpen(true)} data-testid="dashboard-compare-open"
              className="rounded-lg border border-primary/30 bg-white px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5">
              Compare periods
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KPI title="Revenue" value={fmtMoney(periodProfit.revenue)} comparison={comparison(periodProfit.revenue, previousProfit.revenue)} icon={TrendingUp} tint="bg-emerald-50 text-emerald-600" onClick={() => nav("/invoices")} />
          <KPI title="Buyings" value={fmtMoney(periodProfit.buyings)} comparison={comparison(periodProfit.buyings, previousProfit.buyings)} icon={Boxes} tint="bg-violet-50 text-violet-600" onClick={() => nav("/buyings")} />
          <KPI title="Expenses" value={fmtMoney(periodProfit.expenses)} comparison={comparison(periodProfit.expenses, previousProfit.expenses)} icon={Banknote} tint="bg-orange-50 text-orange-600" onClick={() => nav("/expenses")} />
          <KPI title="Final Profit of the Company" value={fmtMoney(periodProfit.profit)} comparison={comparison(periodProfit.profit, previousProfit.profit)} icon={Wallet} tint={periodProfit.profit < 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"} onClick={() => nav("/expenses")} />
        </div>
        <p className="mt-2 text-xs text-slate-400">Revenue is payments received. Final profit = revenue − buyings − recorded expenses. Estimated cash result, not accounting profit.</p>
      </section>

      <section data-testid="dashboard-business-balances">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Business Balances &amp; Stock</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KPI title="Total Invoiced" value={fmtMoney(d.total_invoiced)} icon={Receipt} tint="bg-blue-50 text-blue-600" onClick={() => nav("/invoices")} />
          <KPI title="Payments Received · All Time" value={fmtMoney(d.payments_received)} icon={Wallet} tint="bg-emerald-50 text-emerald-600" onClick={() => nav("/invoices")} />
          <KPI title="Outstanding Balances" value={fmtMoney(d.outstanding)} icon={AlertTriangle} tint="bg-red-50 text-red-600" onClick={() => nav("/client-payments")} />
          <KPI title="Total Stock" value={d.finished_stock} icon={Boxes} tint="bg-amber-50 text-amber-600" onClick={() => nav("/stock")} />
        </div>
      </section>

      <section aria-labelledby="dashboard-operations-heading">
        <h2 id="dashboard-operations-heading" className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Operations at a Glance</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {[["Done Today", d.completed_today, "/production"],
            ["Orders to Send", d.orders_open_count, "/orders"], ["Urgent Orders", d.urgent_orders, "/orders"], ["Vehicles Free", `${d.vehicles_available}/${d.vehicles_total}`, "/fleet"],
            ["Maintenance Due", d.maintenance_due, "/fleet"]].map(([l, v, to]) => (
            <motion.button key={l} whileHover={{ y: -2, scale: 1.01 }} whileTap={{ scale: 0.99 }} transition={{ type: "spring", stiffness: 420, damping: 24, mass: 0.5 }} onClick={() => nav(to)} className="premium-button rounded-lg border border-border bg-white/85 p-3 text-left hover:border-primary/50 hover:bg-white transition-colors" data-testid={`op-kpi-${l.toLowerCase().replace(/\s/g, "-")}`}>
              <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">{l}</p><p className="text-xl font-semibold font-mono tabular-nums text-slate-800 mt-1">{v}</p>
            </motion.button>))}
        </div>
      </section>

      {/* Quick actions */}
      <Card className="premium-card p-5">
        <h3 className="font-bold text-slate-800 mb-4 font-display">Quick Actions</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {QUICK.map((q) => (
            <motion.button key={q.label} whileHover={{ y: -2, scale: 1.01 }} whileTap={{ scale: 0.985 }} transition={{ type: "spring", stiffness: 430, damping: 24, mass: 0.5 }} onClick={() => nav(q.to)} data-testid={`quick-${q.label.toLowerCase().replace(/\s/g, "-")}`}
              className="premium-button flex flex-col items-center gap-2 rounded-lg border border-border bg-white/70 p-4 hover:border-primary/50 hover:bg-accent/35 transition-colors">
              <q.icon size={19} strokeWidth={1.8} className="text-primary" />
              <span className="text-xs font-semibold text-slate-700 text-center">{q.label}</span>
            </motion.button>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Orders to Send" icon={ClipboardList} action={<button onClick={() => nav("/orders")} className="text-xs font-semibold text-primary flex items-center gap-1" data-testid="dash-orders-view">View <ArrowRight size={12} /></button>}>
          {d.orders_to_send?.length ? (
            <div className="space-y-2">{d.orders_to_send.map((o) => (
              <div key={o.id} className="flex justify-between rounded-lg border border-border px-3 py-2" data-testid={`dash-order-${o.id}`}>
                <span className="text-sm font-semibold text-slate-700">{o.customer_name || "-"} <span className="text-slate-400 font-normal">· {o.destination}</span></span>
                <Badge cls={o.priority === "Urgent" || o.priority === "High" ? "bg-red-50 text-red-700 border-red-200" : "bg-slate-100 text-slate-600 border-slate-200"}>{o.priority} · {o.status}</Badge>
              </div>))}</div>
          ) : empty("No orders waiting to be sent.")}
        </Section>

        <Section title="Low Stock Alerts" icon={AlertTriangle}>
          {d.low_stock.length === 0 ? empty("All stock above threshold.") : (
            <div className="space-y-2">
              {d.low_stock.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg bg-red-50 border border-red-100 px-3 py-2">
                  <span className="text-sm font-semibold text-slate-700">{s.product} <span className="text-slate-400 font-normal">· {s.size}</span></span>
                  <Badge cls="bg-red-100 text-red-700 border-red-200">{s.current} left</Badge>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Production Recommendations" icon={TrendingUp}>
          {d.recommendations.length === 0 ? empty("No production needed right now.") : (
            <div className="space-y-2">
              {d.recommendations.map((r, i) => (
                <div key={i} className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2">
                  <div className="flex justify-between"><span className="text-sm font-semibold text-slate-700">{r.product} · {r.size}</span><Badge cls="bg-amber-100 text-amber-700 border-amber-200">Make {r.recommend_qty}</Badge></div>
                  <p className="text-xs text-slate-500 mt-0.5">{r.reason}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Today's Attendance" icon={CalendarCheck} action={<button onClick={() => nav("/attendance")} className="text-xs font-semibold text-primary flex items-center gap-1">View <ArrowRight size={12} /></button>}>
          {d.attendance_today.length === 0 ? empty("No attendance recorded today.") : (
            <div className="space-y-2">{d.attendance_today.map((a) => (
              <div key={a.id} className="flex justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm font-semibold text-slate-700">{a.employee_name}</span><Badge cls="bg-slate-100 text-slate-600 border-slate-200">{a.status}</Badge>
              </div>))}</div>
          )}
        </Section>

        <Section title="Upcoming Deliveries" icon={Truck} action={<button onClick={() => nav("/deliveries")} className="text-xs font-semibold text-primary flex items-center gap-1">View <ArrowRight size={12} /></button>}>
          {d.upcoming_deliveries.length === 0 ? empty("No upcoming deliveries.") : (
            <div className="space-y-2">{d.upcoming_deliveries.map((x) => (
              <div key={x.id} className="flex justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm font-semibold text-slate-700">{x.reference} <span className="text-slate-400 font-normal">· {x.customer_name || x.destination}</span></span><Badge cls="bg-blue-50 text-blue-700 border-blue-200">{x.status}</Badge>
              </div>))}</div>
          )}
        </Section>

        <Section title="Current Stock" icon={Boxes} action={<button onClick={() => nav("/stock")} className="text-xs font-semibold text-primary flex items-center gap-1">View <ArrowRight size={12} /></button>}>
          <div className="space-y-2">{d.current_stock.map((s) => (
            <div key={s.id} className="flex justify-between rounded-lg border border-border px-3 py-2">
              <span className="text-sm font-semibold text-slate-700">{s.product} <span className="text-slate-400 font-normal">· {s.size}</span></span>
              <span className={`text-sm font-mono font-bold ${s.current <= s.threshold ? "text-red-600" : "text-slate-700"}`}>{s.current}</span>
            </div>))}</div>
        </Section>
      </div>

      <Section title="Recent Invoices" icon={Receipt} action={<button onClick={() => nav("/invoices")} className="text-xs font-semibold text-primary flex items-center gap-1">View all <ArrowRight size={12} /></button>}>
        {d.recent_invoices.length === 0 ? empty("No invoices yet. Create your first invoice.") : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 border-b border-border">
                <th className="py-2 font-semibold">Invoice</th><th className="font-semibold">Customer</th><th className="font-semibold">Date</th><th className="font-semibold text-right">Total</th><th className="font-semibold text-right">Balance</th><th className="font-semibold text-center">Status</th>
              </tr></thead>
              <tbody>{d.recent_invoices.map((i) => (
                <tr key={i.id} className="border-b border-border/60 hover:bg-slate-50 cursor-pointer" onClick={() => nav(`/invoices/${i.id}`)}>
                  <td className="py-2.5 font-mono font-semibold text-slate-700">{i.number || "DRAFT"}</td>
                  <td className="text-slate-600">{i.customer_name}</td>
                  <td className="text-slate-500">{fmtDate(i.date)}</td>
                  <td className="text-right font-mono text-slate-700">{fmtMoney(i.total)}</td>
                  <td className="text-right font-mono text-slate-700">{fmtMoney(i.outstanding)}</td>
                  <td className="text-center"><Badge cls={STATUS_META[i.status]?.cls}>{STATUS_META[i.status]?.label}</Badge></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Modal open={compareOpen} onClose={() => setCompareOpen(false)} title="Compare months or years" wide>
        <div className="space-y-5">
          <label className="flex items-center gap-3 text-sm font-semibold text-slate-700">
            Compare by
            <select value={compareKind} onChange={(event) => { setCompareKind(event.target.value); setComparisonResult(null); setComparisonError(""); }}
              data-testid="dashboard-compare-kind"
              className="rounded-lg border border-border bg-white px-3 py-2 text-sm">
              <option value="month">Month vs month</option>
              <option value="year">Year vs year</option>
            </select>
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[0, 1].map((index) => (
              <label key={index} className="space-y-1.5 text-xs font-semibold text-slate-600">
                {index === 0 ? "First period" : "Second period"}
                {compareKind === "month" ? (
                  <input type="month" value={index === 0 ? firstMonth : secondMonth}
                    onChange={(event) => {
                      index === 0 ? setFirstMonth(event.target.value) : setSecondMonth(event.target.value);
                      setComparisonResult(null);
                      setComparisonError("");
                    }}
                    data-testid={`dashboard-compare-month-${index + 1}`}
                    className="block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-normal text-slate-700" />
                ) : (
                  <select value={index === 0 ? firstYear : secondYear}
                    onChange={(event) => {
                      index === 0 ? setFirstYear(event.target.value) : setSecondYear(event.target.value);
                      setComparisonResult(null);
                      setComparisonError("");
                    }}
                    data-testid={`dashboard-compare-year-${index + 1}`}
                    className="block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-normal text-slate-700">
                    {Array.from({ length: Math.max(1, Number(currentMonth.slice(0, 4)) - 1999) }, (_, offset) => String(Number(currentMonth.slice(0, 4)) - offset))
                      .map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                )}
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <button onClick={runCustomComparison} disabled={comparisonLoading} data-testid="dashboard-compare-run"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
              {comparisonLoading ? "Comparing..." : "Compare"}
            </button>
          </div>
          {comparisonError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{comparisonError}</p>}
          {comparisonResult && (
            <div className="space-y-3" data-testid="dashboard-compare-results">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[comparisonResult.first, comparisonResult.second].map((entry) => (
                  <div key={entry.value} className="rounded-xl border border-border bg-slate-50/70 p-4">
                    <h3 className="font-bold text-slate-800">{compareLabel(entry, comparisonResult.kind)}</h3>
                    <p className="mt-1 text-xs text-slate-500">{fmtDate(entry.start)} – {fmtDate(entry.end)}</p>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Revenue</dt><dd className="font-mono font-semibold">{fmtMoney(entry.revenue)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Buyings</dt><dd className="font-mono">{fmtMoney(entry.buyings)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Expenses</dt><dd className="font-mono">{fmtMoney(entry.expenses)}</dd></div>
                      <div className="flex justify-between gap-2 border-t border-border pt-2"><dt className="font-semibold text-slate-700">Final Profit</dt><dd className="font-mono font-bold">{fmtMoney(entry.profit)}</dd></div>
                    </dl>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-primary/15 bg-primary/5 px-4 py-3 text-sm">
                <span className="font-semibold text-slate-700">Difference (second − first): </span>
                Revenue {comparisonDifference(comparisonResult.second.revenue, comparisonResult.first.revenue)} ·
                Buyings {comparisonDifference(comparisonResult.second.buyings, comparisonResult.first.buyings)} ·
                Expenses {comparisonDifference(comparisonResult.second.expenses, comparisonResult.first.expenses)} ·
                Final Profit {comparisonDifference(comparisonResult.second.profit, comparisonResult.first.profit)}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
