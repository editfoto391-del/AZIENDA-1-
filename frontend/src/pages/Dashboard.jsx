import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  { label: "Create Order", icon: ClipboardList, to: "/orders" },
  { label: "Record Expense", icon: Banknote, to: "/expenses" },
];

const MANUFACTURING_COMPANY_ID = "iqfoam-manufactoring";
const WORKER_SECTION_OPTIONS = [
  ["customers", "Customers"], ["suppliers", "Suppliers"], ["buyings", "Buyings"],
  ["invoices", "Invoice"], ["express-invoices", "Express Website Invoices"],
  ["orders", "Orders"], ["intercompany", "Intercompany"],
  ["stock", "Stock"], ["company-inventory", "Company Inventory"],
  ["production", "Production", ["superiqfoam"]],
  ["chemicals-quantity", "Chemicals Quantity", ["superiqfoam"]],
  ["chemical-usage-log", "Chemical Usage Log", ["superiqfoam"]],
  ["warehouse-a", "Warehouse A", [MANUFACTURING_COMPANY_ID]],
  ["warehouse-b", "Warehouse B", [MANUFACTURING_COMPANY_ID]],
  ["warehouse-c", "Warehouse C", [MANUFACTURING_COMPANY_ID]],
  ["warehouse-chemical", "Chemical", [MANUFACTURING_COMPANY_ID]],
  ["warehouse-chemical-inventory", "Chemical Inventory", [MANUFACTURING_COMPANY_ID]],
  ["attendance", "Attendance"], ["deliveries", "Deliveries"],
  ["fleet", "Fleet"], ["expenses", "Expenses"], ["costs", "Costs report"],
  ["grv", "GRV"], ["daily-report", "Daily Report"],
  ["client-payments", "Clients payment and balances"],
  ["express-client-payments", "Express Website Payments and Balances"],
  ["settings", "Settings"],
];
const SUPERVISOR_ACTION_SECTIONS = {
  invoice_edit: ["invoices"],
  price_edit: ["settings"],
  price_delete: ["settings"],
  customer_delete: ["customers"],
  stock_delete: ["stock"],
  production_block_record: ["production"],
  balance_payment_delete: ["customers", "client-payments", "express-client-payments"],
};
const WORKER_SECTION_OPERATIONS = {
  customers: [["create", "Add customer"], ["update", "Edit customer"], ["delete", "Delete customer"]],
  suppliers: [["create", "Add supplier"], ["update", "Edit supplier"], ["delete", "Delete supplier"]],
  buyings: [["create", "Record purchase"], ["update", "Edit purchase"], ["delete", "Delete purchase"]],
  invoices: [["create", "Create invoice"], ["update", "Edit / void invoice"], ["delete", "Delete invoice"]],
  "express-invoices": [["create", "Create invoice"], ["update", "Edit / void invoice"], ["delete", "Delete invoice"]],
  orders: [["create", "Create order"], ["update", "Edit order"], ["delete", "Delete order"]],
  intercompany: [["create", "Create request"], ["update", "Manage request"], ["delete", "Cancel request"]],
  stock: [["create", "Add stock"], ["update", "Adjust stock"], ["delete", "Delete stock item"]],
  "company-inventory": [["create", "Add product"], ["update", "Edit product"], ["delete", "Delete product"]],
  production: [["create", "Record production"], ["update", "Edit production"], ["delete", "Delete production record"]],
  "chemicals-quantity": [["create", "Record quantity"], ["update", "Update quantity"], ["delete", "Delete quantity record"]],
  "chemical-usage-log": [["create", "Record usage"], ["update", "Edit usage"], ["delete", "Delete usage record"]],
  "warehouse-a": [["create", "Create report"], ["update", "Edit report"], ["delete", "Delete report"]],
  "warehouse-b": [["create", "Create report"], ["update", "Edit report"], ["delete", "Delete report"]],
  "warehouse-c": [["create", "Create report"], ["update", "Edit report"], ["delete", "Delete report"]],
  "warehouse-chemical": [["create", "Record usage"], ["update", "Edit usage"], ["delete", "Delete usage record"]],
  "warehouse-chemical-inventory": [["create", "Record quantity"], ["update", "Update quantity"], ["delete", "Delete quantity record"]],
  attendance: [["create", "Record attendance"], ["update", "Edit attendance"], ["delete", "Delete attendance record"]],
  deliveries: [["create", "Schedule delivery"], ["update", "Edit delivery"], ["delete", "Delete delivery"]],
  fleet: [["create", "Add fleet record"], ["update", "Edit fleet record"], ["delete", "Delete fleet record"]],
  expenses: [["create", "Record expense"], ["update", "Edit expense"], ["delete", "Delete expense"]],
  costs: [],
  grv: [["create", "Create GRV"], ["update", "Edit GRV"], ["delete", "Delete GRV"]],
  "daily-report": [["update", "Edit daily report"]],
  "client-payments": [["create", "Record payment"], ["update", "Reverse payment"], ["delete", "Delete payment"]],
  "express-client-payments": [["create", "Record payment"], ["update", "Reverse payment"], ["delete", "Delete payment"]],
  settings: [["create", "Add price / setting"], ["update", "Change price / setting"], ["delete", "Delete price / setting"]],
  warehouses: [["create", "Add warehouse record"], ["update", "Edit warehouse record"], ["delete", "Delete warehouse record"]],
};
const WORKER_WRITE_OPTIONS = [
  ["deny", "No access"],
  ["allow", "Without password"],
  ["supervisor", "With supervisor password"],
];
const LEGACY_WORKER_ACTIONS = {
  invoice_edit: [["invoices", "update"]],
  price_edit: [["settings", "create"], ["settings", "update"]],
  price_delete: [["settings", "delete"]],
  customer_delete: [["customers", "delete"]],
  stock_delete: [["stock", "delete"]],
  production_block_record: [["production", "create"]],
  balance_payment_delete: [["client-payments", "delete"]],
};
const defaultWorkerWritePermissions = (sections, current = {}, legacyActions = []) =>
  Object.fromEntries(sections.map((section) => [section, Object.fromEntries(
    ["create", "update", "delete"].map((operation) => {
      const sectionOperations = WORKER_SECTION_OPERATIONS[section] || [];
      if (!sectionOperations.some(([availableOperation]) => availableOperation === operation)) {
        return [operation, "deny"];
      }
      const prior = current[section]?.[operation];
      const legacyRequiresPassword = legacyActions.some((action) =>
        LEGACY_WORKER_ACTIONS[action]?.some(([legacySection, legacyOperation]) =>
          legacySection === section && legacyOperation === operation));
      if (["invoices", "express-invoices"].includes(section) && operation === "delete") {
        return [operation, prior === "deny" ? "deny" : "supervisor"];
      }
      return [operation, WORKER_WRITE_OPTIONS.some(([value]) => value === prior)
        ? prior
        : legacyRequiresPassword ? "supervisor" : "allow"];
    }),
  )]));
const currentMonth = today().slice(0, 7);
const previousMonth = (month) => {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthLabel = (value) => new Date(`${value}-01T00:00:00`).toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });

const KPI_SPARKLINES = {
  default: "M0 64C32 61 47 53 73 57s36-19 62-14 40-30 65-19 15 1 20-6",
  up: "M0 55C25 54 37 47 58 47S91 38 112 38S148 27 167 26S199 15 220 10",
  blue: "M0 55C25 54 37 47 58 47S91 38 112 38S148 27 167 26S199 15 220 10",
  down: "M0 10C25 11 37 18 58 18S91 27 112 27S148 38 167 39S199 50 220 55",
  zigzag: "M0 39C18 38 29 19 47 20S78 48 98 48S128 25 148 25S178 48 196 40S212 29 220 27",
};

function KPI({ title, value, icon: Icon, tint, onClick, comparison, sparkline = "default" }) {
  const sparklinePath = KPI_SPARKLINES[sparkline] || KPI_SPARKLINES.default;
  return (
    <div className="transition-transform duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.995]">
      <Card className="premium-card group p-5 cursor-pointer border-l-2 border-l-transparent hover:border-l-primary hover:shadow-md transition-all" onClick={onClick} data-testid={`kpi-${title.toLowerCase().replace(/\s/g, "-")}`}>
        <svg className={`dashboard-kpi-sparkline dashboard-kpi-sparkline-${sparkline}`} viewBox="0 0 220 70" preserveAspectRatio="none" aria-hidden="true">
          <path d={`${sparklinePath}L220 70H0Z`} />
          <path className="dashboard-kpi-sparkline-glow" d={sparklinePath} />
          <path d={sparklinePath} />
        </svg>
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
    </div>
  );
}

function Section({ title, icon: Icon, children, action }) {
  return (
    <div>
      <Card className="premium-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-800 flex items-center gap-2 font-display text-lg">
            {Icon && <Icon size={17} strokeWidth={1.8} className="text-primary" />} {title}
          </h3>
          {action}
        </div>
        {children}
      </Card>
    </div>
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{cards(3)}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{cards(5, "!p-3")}</div>
      <div className="luxury-card rounded-lg border border-border bg-white p-5">
        <SkeletonBlock className="mb-5 h-4 w-32" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 9 }, (_, index) => (
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
  const [customStart, setCustomStart] = useState(`${currentMonth}-01`);
  const [customEnd, setCustomEnd] = useState(today());
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
  const [workerPassword, setWorkerPassword] = useState("");
  const [workerPasswordSaved, setWorkerPasswordSaved] = useState(false);
  const [workerDraft, setWorkerDraft] = useState({
    name: "", username: "", email: "", worker_role: "", password: "",
    company_id: user?.company_id || "", allowed_sections: ["invoices"], stock_only: false,
    is_supervisor: false, warehouse_ids: [], supervisor_password_actions: [],
    is_admin: false,
    can_edit_invoice_prices: false,
    write_permissions: defaultWorkerWritePermissions(["invoices"]),
  });
  const canManageWorkers = !!(
    user?.is_owner || user?.is_company_owner || user?.role === "owner"
  );

  const [companyInventory, setCompanyInventory] = useState(null);
  const [companyInventoryError, setCompanyInventoryError] = useState("");
  const [companyInventoryReload, setCompanyInventoryReload] = useState(0);
  useEffect(() => {
    if (user?.is_worker && !user.allowed_sections?.includes("company-inventory")) return;
    setCompanyInventory(null);
    setCompanyInventoryError("");
    api.getUncached("/company-inventory")
      .then((items) => setCompanyInventory(items || []))
      .catch((error) => setCompanyInventoryError(apiError(error)));
  }, [user, companyInventoryReload]);

  useEffect(() => {
    if (!canManageWorkers) return;
    api.get("/companies/profiles")
      .then((companyList) => {
        const manageableCompanyIds = user.role === "owner"
          ? user.company_ids
          : user.owner_company_ids;
        const accessibleCompanies = companyList.filter((company) =>
          manageableCompanyIds?.includes(company.id)
          && (!dedicatedDomain || company.id === dedicatedDomain.companyId)
        );
        setCompanies(accessibleCompanies);
        setWorkerCompanyId((current) => dedicatedDomain?.companyId || current || user.company_id || accessibleCompanies[0]?.id || "");
      })
      .catch((error) => toast.error(apiError(error)));
  }, [user, canManageWorkers]);

  useEffect(() => {
    if (!canManageWorkers || !workerCompanyId) return;
    setWorkers([]);
    api.get("/access/workers", { company_id: workerCompanyId })
      .then(setWorkers)
      .catch((error) => toast.error(apiError(error)));
  }, [user, workerCompanyId, canManageWorkers]);

  useEffect(() => {
    let active = true;
    setD(null);
    setLoadingError("");
    const params = period === "custom"
      ? { period, start_date: customStart, end_date: customEnd }
      : { period };
    api.get("/dashboard", params)
      .then((data) => { if (active) setD(data); })
      .catch((error) => { if (active) setLoadingError(apiError(error)); });
    const refreshOnChange = () => setReload((value) => value + 1);
    window.addEventListener("erp:data-changed", refreshOnChange);
    return () => {
      active = false;
      window.removeEventListener("erp:data-changed", refreshOnChange);
    };
  }, [period, customStart, customEnd, reload]);

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
  const periodLabels = { today: "Today", week: "This Week", month: "This Month", year: "This Year", custom: "Custom Period" };
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
          is_supervisor: workerDraft.is_supervisor,
          warehouse_ids: workerDraft.warehouse_ids,
          supervisor_password_actions: workerDraft.supervisor_password_actions,
          write_permissions: workerDraft.write_permissions,
          can_edit_invoice_prices: workerDraft.can_edit_invoice_prices,
          is_admin: workerDraft.is_admin,
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
        is_supervisor: false, warehouse_ids: [], supervisor_password_actions: [],
        is_admin: false,
        can_edit_invoice_prices: false,
        write_permissions: defaultWorkerWritePermissions(["invoices"]),
      });
      setWorkerModalOpen(false);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkerSaving(false);
    }
  };
  const toggleWorkerSection = (section) => setWorkerDraft((current) => {
    const removingSection = current.allowed_sections.includes(section);
    const nextSections = removingSection
      ? current.allowed_sections.filter((item) => item !== section)
      : [...current.allowed_sections, section];
    const writePermissions = { ...current.write_permissions };
    if (removingSection) delete writePermissions[section];
    else writePermissions[section] = defaultWorkerWritePermissions([section])[section];
    const warehouseId = section.match(/^warehouse-([abc])$/)?.[1]?.toUpperCase();
    const warehouseIds = warehouseId
      ? removingSection
        ? current.warehouse_ids.filter((id) => id !== warehouseId)
        : [...new Set([...current.warehouse_ids, warehouseId])]
      : current.warehouse_ids;
    return {
      ...current,
      allowed_sections: nextSections,
      warehouse_ids: warehouseIds,
      can_edit_invoice_prices: nextSections.some((item) => ["invoices", "express-invoices"].includes(item))
        ? current.can_edit_invoice_prices
        : false,
      supervisor_password_actions: current.supervisor_password_actions.filter((item) =>
        SUPERVISOR_ACTION_SECTIONS[item].some((required) => nextSections.includes(required))),
      write_permissions: writePermissions,
    };
  });
  const activeCompanyName = companies.find((company) => company.id === workerDraft.company_id)?.name || workerDraft.company_id;
  const changeWorkerCompany = async (companyId) => {
    const availableSections = WORKER_SECTION_OPTIONS
      .filter(([, , companyIds]) => !companyIds || companyIds.includes(companyId))
      .map(([section]) => section);
    setWorkerDraft((current) => ({
      ...current,
      company_id: companyId,
      warehouse_ids: current.warehouse_ids.filter((id) => availableSections.includes(`warehouse-${id.toLowerCase()}`)),
      supervisor_password_actions: [],
      can_edit_invoice_prices: current.can_edit_invoice_prices
        && current.allowed_sections.some((section) =>
          availableSections.includes(section) && ["invoices", "express-invoices"].includes(section)),
      write_permissions: Object.fromEntries(Object.entries(current.write_permissions)
        .filter(([section]) => availableSections.includes(section) && current.allowed_sections.includes(section))),
      allowed_sections: current.allowed_sections.filter((section) => availableSections.includes(section)),
    }));
  };
  const editWorker = (worker) => {
    const legacySections = new Set(worker.allowed_sections || []);
    const expandedSections = new Set(legacySections);
    if (legacySections.has("invoices")) expandedSections.add("express-invoices");
    if (legacySections.has("client-payments")) expandedSections.add("express-client-payments");
    if (legacySections.has("orders")) expandedSections.add("intercompany");
    if (legacySections.has("stock") && !worker.stock_only) expandedSections.add("company-inventory");
    const workerWarehouseIds = worker.warehouse_ids || [];
    if (legacySections.has("warehouses")) {
      workerWarehouseIds.forEach((id) => expandedSections.add(`warehouse-${id.toLowerCase()}`));
      expandedSections.add(worker.company_id === "superiqfoam" ? "chemical-usage-log" : "warehouse-chemical");
      expandedSections.add(worker.company_id === "superiqfoam" ? "chemicals-quantity" : "warehouse-chemical-inventory");
    }
    const expandedSectionList = [...expandedSections].filter((section) => WORKER_SECTION_OPTIONS
      .some(([option, , companyIds]) => option === section && (!companyIds || companyIds.includes(worker.company_id))));
    const expandedWritePermissions = { ...(worker.write_permissions || {}) };
    const permissionAliases = {
      invoices: ["express-invoices"],
      orders: ["intercompany"],
      "client-payments": ["express-client-payments"],
    };
    if (!worker.stock_only) permissionAliases.stock = ["company-inventory"];
    Object.entries(permissionAliases).forEach(([legacySection, newSections]) => {
      newSections.forEach((section) => {
        if (expandedSectionList.includes(section) && !expandedWritePermissions[section]) {
          expandedWritePermissions[section] = worker.write_permissions?.[legacySection]
            || defaultWorkerWritePermissions([section])[section];
        }
      });
    });
    setWorkerDraft({
      id: worker.id,
      name: worker.name,
      username: worker.username,
      email: "",
      worker_role: worker.worker_role,
      password: "",
      company_id: worker.company_id,
      allowed_sections: expandedSectionList,
      stock_only: worker.stock_only === true,
      is_supervisor: worker.is_supervisor === true,
      warehouse_ids: workerWarehouseIds,
      supervisor_password_actions: (worker.supervisor_password_actions || []).filter((action) =>
        !SUPERVISOR_ACTION_SECTIONS[action]
        || SUPERVISOR_ACTION_SECTIONS[action].some((section) => expandedSectionList.includes(section))),
      is_admin: worker.is_admin === true,
      can_edit_invoice_prices: worker.can_edit_invoice_prices === true,
      write_permissions: defaultWorkerWritePermissions(
        expandedSectionList,
        expandedWritePermissions,
        worker.supervisor_password_actions || [],
      ),
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
    setWorkerPassword("");
    setWorkerPasswordSaved(false);
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
  const saveWorkerPassword = async (event) => {
    event.preventDefault();
    if (!workerLinkInfo || workerLinkSaving) return;
    if (workerPassword.length < 8) {
      toast.error("Password must contain at least 8 characters");
      return;
    }
    setWorkerLinkSaving(true);
    try {
      await api.put(
        `/access/workers/${workerLinkInfo.id}/password?company_id=${encodeURIComponent(workerLinkInfo.company_id)}`,
        { password: workerPassword },
      );
      setWorkerPasswordSaved(true);
      toast.success("Worker password updated");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkerLinkSaving(false);
    }
  };
  const copyWorkerPassword = async () => {
    if (!workerPasswordSaved || !workerPassword) return;
    try {
      await navigator.clipboard.writeText(workerPassword);
      toast.success("Worker password copied");
    } catch (error) {
      toast.error(apiError(error));
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
    <div className="dashboard-design dashboard-stagger relative isolate space-y-6">
      <div className="dashboard-backdrop pointer-events-none absolute inset-x-0 top-[-1.5rem] z-0 h-[21rem] overflow-hidden" aria-hidden="true">
        <svg className="dashboard-ribbons absolute inset-0 h-full w-full" viewBox="0 0 1440 360" preserveAspectRatio="none">
          <defs>
            <linearGradient id="dashboard-ribbon-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#d7e3d8" stopOpacity=".01" />
              <stop offset=".5" stopColor="#a9b9ad" stopOpacity=".1" />
              <stop offset="1" stopColor="#d7e3d8" stopOpacity=".01" />
            </linearGradient>
            <linearGradient id="dashboard-ribbon-line" x1="0" y1="0" x2="1" y2=".1">
              <stop offset="0" stopColor="#d3dfd5" stopOpacity="0" />
              <stop offset=".52" stopColor="#d3dfd5" stopOpacity=".38" />
              <stop offset="1" stopColor="#d3dfd5" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M548 263c124-30 261-133 401-175 153-46 233 27 343 36 57 5 102-8 158-42v143c-79 41-132 57-207 30-113-41-190-92-307-63-134 33-244 112-341 116-21 1-37-15-47-45Z" fill="url(#dashboard-ribbon-fill)" />
          <path d="M522 276c164-47 285-150 423-194 156-50 237 22 349 31 52 4 103-13 156-43M558 291c163-46 273-126 410-168 147-45 226 29 338 44 58 8 104-10 144-32M708 302c112-41 190-94 303-126 117-33 195 28 290 47 60 12 105 0 149-22" fill="none" stroke="url(#dashboard-ribbon-line)" strokeWidth="1.1" />
          <path d="M767 249c108-57 193-102 286-106 102-5 164 51 252 63 55 8 96-3 145-26" fill="none" stroke="#d3dfd5" strokeOpacity=".12" strokeWidth="5" />
        </svg>
      </div>
      <div className="dashboard-hero relative z-10 flex flex-wrap items-end justify-between gap-4">
        <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Admin · Operations</p>
        <h1 className="mt-1 font-display text-4xl font-normal text-slate-900 sm:text-5xl">Business overview</h1>
        <p className="mt-1 font-display text-base italic text-slate-500">Performance, cash flow and daily operations</p>
        </div>
        {canManageWorkers && <Btn onClick={() => { setWorkerDraft({ name: "", username: "", email: "", worker_role: "", password: "", company_id: user?.company_id || "", allowed_sections: ["invoices"], stock_only: false, is_supervisor: false, warehouse_ids: [], supervisor_password_actions: [], is_admin: false, can_edit_invoice_prices: false, write_permissions: defaultWorkerWritePermissions(["invoices"]) }); setWorkerModalOpen(true); }} data-testid="add-worker-open"><UserPlus size={16} /> Add Worker</Btn>}
      </div>
      <div className="dashboard-period-panel relative z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-white/70 p-3" data-testid="dashboard-period-controls">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dashboard date range">
          {[["today", "Today"], ["week", "This week"], ["month", "This month"]].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
              data-testid={`dashboard-period-${value}`}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${period === value ? "bg-primary text-white" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {label}
            </button>
          ))}
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            More
            <select
              value={period === "year" || period === "custom" ? period : ""}
              onChange={(event) => event.target.value && setPeriod(event.target.value)}
              data-testid="dashboard-period-select"
              aria-label="More dashboard periods"
              className="rounded-lg border border-border bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="">More periods</option>
              <option value="year">This Year</option>
              <option value="custom">Custom Period</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {period === "custom" && <>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              From <input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)}
                data-testid="dashboard-custom-start" className="rounded-lg border border-border bg-white px-2 py-2 text-sm" />
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              To <input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)}
                data-testid="dashboard-custom-end" className="rounded-lg border border-border bg-white px-2 py-2 text-sm" />
            </label>
          </>}
          <button onClick={() => setCompareOpen(true)} data-testid="dashboard-compare-open"
            className="rounded-lg border border-primary/30 bg-white px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5">
            Compare periods
          </button>
        </div>
        <p className="mt-2 w-full text-[11px] text-slate-500">
          The selected period filters financial results, orders, invoices, attendance, and scheduled deliveries. Stock, balances, and fleet availability show current values.
        </p>
      </div>

      <Section title="Company Inventory" icon={Boxes} action={<button onClick={() => nav("/company-inventory")} className="text-xs font-semibold text-primary flex items-center gap-1" data-testid="dashboard-company-inventory-link">View <ArrowRight size={12} /></button>}>
        {user?.is_worker && !user.allowed_sections?.includes("company-inventory") ? (
          <p className="text-sm text-slate-500">Company Inventory requires Company Inventory access. Ask your administrator to update your permissions.</p>
        ) : companyInventoryError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-red-700" role="alert">{companyInventoryError}</p>
            <button type="button" onClick={() => setCompanyInventoryReload((value) => value + 1)} className="text-xs font-semibold text-primary" data-testid="dashboard-company-inventory-retry">Try again</button>
          </div>
        ) : companyInventory === null ? (
          <p className="text-sm text-slate-400" role="status">Loading company inventory...</p>
        ) : companyInventory.length === 0 ? empty("No company inventory items yet.") : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="dashboard-company-inventory">
            {companyInventory.map((item) => (
              <div key={item.id} className="flex justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm font-semibold text-slate-700">{item.name} <span className="text-slate-400 font-normal">· {item.category}{item.size ? ` ${item.size}` : ""}</span></span>
                <span className="text-sm font-mono font-bold text-slate-700">{Number(item.total || 0).toLocaleString()} {item.unit}</span>
              </div>))}
          </div>
        )}
      </Section>

      {canManageWorkers && <Section title="Workers" icon={UserPlus} action={<div className="flex items-center gap-3">
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
                  <td className="py-3 text-slate-600">
                    <span>{worker.worker_role}</span>
                    {worker.is_admin && <Badge cls="ml-2 border-amber-200 bg-amber-50 text-amber-700">Admin</Badge>}
                    {worker.is_supervisor && <Badge cls="ml-2 border-violet-200 bg-violet-50 text-violet-700">Supervisor</Badge>}
                  </td>
                  <td className="py-3 text-slate-600">
                    {companies.find((company) => company.id === worker.company_id)?.name || worker.company_id}
                    {(worker.warehouse_ids || []).length > 0 && <span className="mt-1 block text-xs text-slate-400">Warehouse {worker.warehouse_ids.join(", ")}</span>}
                  </td>
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

      {canManageWorkers && <Modal open={workerModalOpen} onClose={() => !workerSaving && setWorkerModalOpen(false)} title={workerDraft.id ? "Edit Worker Access" : "Add Worker"} wide>
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
          <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={workerDraft.is_admin}
              onChange={(event) => setWorkerDraft((current) => ({ ...current, is_admin: event.target.checked }))}
              data-testid="worker-admin"
            />
            <span>
              <span className="block font-semibold">Also assign the Admin role</span>
              <span className="block text-xs text-slate-500">The account remains restricted to the sections and actions configured below.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border border-violet-200 bg-violet-50/50 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={workerDraft.is_supervisor}
              disabled={workerDraft.stock_only}
              onChange={(event) => setWorkerDraft((current) => ({
                ...current,
                is_supervisor: event.target.checked,
                supervisor_password_actions: event.target.checked ? current.supervisor_password_actions : [],
              }))}
              data-testid="worker-supervisor"
            />
            <span>
              <span className="block font-semibold">Make Supervisor</span>
              <span className="block text-xs text-slate-500">Marks this worker as a designated supervisor. Choose password requirements for individual actions in the permissions table.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700">
            <input type="checkbox" checked={workerDraft.stock_only} onChange={(event) => setWorkerDraft((current) => ({
              ...current,
              stock_only: event.target.checked,
              worker_role: event.target.checked ? "Stock Controller" : current.worker_role,
              allowed_sections: event.target.checked ? ["stock"] : current.allowed_sections,
              warehouse_ids: event.target.checked ? [] : current.warehouse_ids,
              is_supervisor: event.target.checked ? false : current.is_supervisor,
              supervisor_password_actions: event.target.checked ? [] : current.supervisor_password_actions,
              can_edit_invoice_prices: event.target.checked ? false : current.can_edit_invoice_prices,
              write_permissions: event.target.checked
                ? { stock: current.write_permissions.stock || defaultWorkerWritePermissions(["stock"]).stock }
                : current.write_permissions,
            }))} data-testid="worker-stock-only" />
            <span><span className="block font-semibold">Stock-only sub-user</span><span className="block text-xs text-slate-500">Can access stock only; selling prices are visible, purchase costs are hidden.</span></span>
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-slate-700">Sections this worker can access</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {WORKER_SECTION_OPTIONS.filter(([section, , companyIds]) =>
                (!companyIds || companyIds.includes(workerDraft.company_id))
                && (!workerDraft.stock_only || section === "stock")
              ).map(([section, label]) => (
                <label key={section} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700">
                  <input type="checkbox" checked={workerDraft.allowed_sections.includes(section)} onChange={() => toggleWorkerSection(section)} data-testid={`worker-section-${section}`} />
                  {label}
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">Each page has its own permission. Warehouse A, B and C also assign access to the matching warehouse.</p>
          </fieldset>
          {workerDraft.allowed_sections.some((section) => ["invoices", "express-invoices"].includes(section)) && (
            <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700" data-testid="worker-invoice-price-permission">
              <input
                type="checkbox"
                checked={workerDraft.can_edit_invoice_prices}
                onChange={(event) => setWorkerDraft((current) => ({
                  ...current,
                  can_edit_invoice_prices: event.target.checked,
                }))}
                data-testid="worker-can-edit-invoice-prices"
              />
              <span>
                <span className="block font-semibold">Allow this worker to edit invoice prices</span>
                <span className="block text-xs text-slate-500">When disabled, invoice item prices must stay at the configured price. This applies to standard and express invoices.</span>
              </span>
            </label>
          )}
          <fieldset className="space-y-3 rounded-md border border-border p-3" data-testid="worker-write-permissions">
            <legend className="px-1 text-sm font-semibold text-slate-700">Section actions and password rules</legend>
            <p className="text-xs text-slate-500">Each section shows its relevant actions. For each one, choose no access, access without a password, or require the company Supervisor Password.</p>
            <div className="space-y-2">
              {workerDraft.allowed_sections.map((section) => (
                <div key={section} className="space-y-3 rounded-md border border-border/70 bg-slate-50 p-3">
                  <p className="self-center text-sm font-semibold text-slate-700">
                    {WORKER_SECTION_OPTIONS.find(([key]) => key === section)?.[1] || section}
                  </p>
                  {(WORKER_SECTION_OPERATIONS[section] || []).length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {WORKER_SECTION_OPERATIONS[section].map(([operation, label]) => (
                        <label key={operation} className="space-y-1 text-xs font-medium text-slate-500">
                          <span>{label}</span>
                          <select
                            value={workerDraft.write_permissions[section]?.[operation] || "deny"}
                            onChange={(event) => setWorkerDraft((current) => ({
                              ...current,
                              write_permissions: {
                                ...current.write_permissions,
                                [section]: {
                                  ...current.write_permissions[section],
                                  [operation]: event.target.value,
                                },
                              },
                            }))}
                            data-testid={`worker-permission-${section}-${operation}`}
                            className="w-full rounded-md border border-input bg-white px-2 py-2 text-sm text-slate-700"
                          >
                            {WORKER_WRITE_OPTIONS.filter(([value]) =>
                              !(["invoices", "express-invoices"].includes(section) && operation === "delete" && value === "allow")
                            ).map(([value, optionLabel]) => <option key={value} value={value}>{optionLabel}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">Read-only section; no create, edit, or delete actions.</p>
                  )}
                </div>
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

      {canManageWorkers && <Modal
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
            <form onSubmit={saveWorkerPassword} className="space-y-2 border-t border-border/70 pt-4">
              <label htmlFor="worker-password" className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                {workerPasswordSaved ? "Worker password" : "Set worker password"}
              </label>
              <div className="flex gap-2">
                <input
                  id="worker-password"
                  type="text"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={workerPassword}
                  onChange={(event) => {
                    setWorkerPassword(event.target.value);
                    setWorkerPasswordSaved(false);
                  }}
                  placeholder="Enter a new password (at least 8 characters)"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none"
                  data-testid="worker-password-input"
                />
                {workerPasswordSaved
                  ? <Btn type="button" variant="outline" onClick={copyWorkerPassword} data-testid="worker-copy-password"><Copy size={15} /> Copy</Btn>
                  : <Btn type="submit" disabled={workerLinkSaving || workerPassword.length < 8} data-testid="worker-save-password">Set Password</Btn>}
              </div>
              <p className="text-xs text-slate-500">Existing passwords cannot be viewed. Setting a new password will sign the worker out of active sessions.</p>
            </form>
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
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-7">
          <KPI title="Total Invoiced" value={fmtMoney(periodProfit.total_invoiced)} comparison={comparison(periodProfit.total_invoiced, previousProfit.total_invoiced)} icon={Receipt} tint="bg-blue-50 text-blue-600" onClick={() => nav("/invoices")} sparkline="blue" />
          <KPI title="Payments Received · Revenue" value={fmtMoney(periodProfit.revenue)} comparison={comparison(periodProfit.revenue, previousProfit.revenue)} icon={TrendingUp} tint="bg-emerald-50 text-emerald-600" onClick={() => nav("/invoices")} sparkline="up" />
          <KPI title="Buyings" value={fmtMoney(periodProfit.buyings)} comparison={comparison(periodProfit.buyings, previousProfit.buyings)} icon={Boxes} tint="bg-violet-50 text-violet-600" onClick={() => nav("/buyings")} />
          <KPI title="GRV Purchases" value={fmtMoney(periodProfit.grv_expenses)} comparison={comparison(periodProfit.grv_expenses, previousProfit.grv_expenses)} icon={Boxes} tint="bg-indigo-50 text-indigo-600" onClick={() => nav("/grv")} sparkline="zigzag" />
          <KPI title="Calculated Salaries" value={fmtMoney(periodProfit.salaries)} comparison={comparison(periodProfit.salaries, previousProfit.salaries)} icon={Banknote} tint="bg-amber-50 text-amber-600" onClick={() => nav("/attendance")} sparkline="down" />
          <KPI title="Expenses" value={fmtMoney(periodProfit.expenses)} comparison={comparison(periodProfit.expenses, previousProfit.expenses)} icon={Banknote} tint="bg-orange-50 text-orange-600" onClick={() => nav("/expenses")} sparkline="down" />
          <KPI title="Final Profit of the Company" value={fmtMoney(periodProfit.profit)} comparison={comparison(periodProfit.profit, previousProfit.profit)} icon={Wallet} tint={periodProfit.profit < 0 ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"} onClick={() => nav("/expenses")} sparkline="up" />
        </div>
        <p className="mt-2 text-xs text-slate-400">Total Invoiced is invoices issued. Revenue is payments received. Company profit = revenue − expenses − Buyings − salaries − accepted GRV costs.</p>
      </section>

      <section data-testid="dashboard-business-balances">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Current Balances &amp; Stock</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <KPI title="Outstanding · Current" value={fmtMoney(d.outstanding)} icon={AlertTriangle} tint="bg-red-50 text-red-600" onClick={() => nav("/client-payments")} />
          <KPI title="Total Stock" value={d.finished_stock} icon={Boxes} tint="bg-amber-50 text-amber-600" onClick={() => nav("/stock")} />
        </div>
      </section>

      {(!user?.is_worker || user.allowed_sections?.includes("fleet")) && (
        <section data-testid="dashboard-fleet-alerts" aria-labelledby="dashboard-fleet-alerts-heading">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="dashboard-fleet-alerts-heading" className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Current Fleet Alerts</h2>
            <button type="button" onClick={() => nav("/fleet")} className="flex items-center gap-1 text-xs font-semibold text-primary" data-testid="dashboard-fleet-alerts-view">View Fleet <ArrowRight size={12} /></button>
          </div>
          <Card className="p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div><p className="text-[10px] font-semibold uppercase text-slate-500">Licence discs expiring soon</p><p className="mt-1 text-xl font-bold font-mono text-amber-700">{d.fleet_alerts?.expiring_soon || 0}</p></div>
              <div><p className="text-[10px] font-semibold uppercase text-slate-500">Expired licence discs</p><p className="mt-1 text-xl font-bold font-mono text-red-700">{d.fleet_alerts?.expired || 0}</p></div>
              <div><p className="text-[10px] font-semibold uppercase text-slate-500">Vehicles requiring maintenance</p><p className="mt-1 text-xl font-bold font-mono text-blue-700">{d.fleet_alerts?.maintenance_required_count || 0}</p></div>
            </div>
            {!!d.fleet_alerts?.items?.length && <div className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
              {d.fleet_alerts.items.map((alert) => <button key={alert.vehicle_id} type="button" onClick={() => nav(`/fleet?vehicleId=${encodeURIComponent(alert.vehicle_id)}&section=licence`)} className="flex w-full items-center justify-between gap-3 py-2 text-left" data-testid={`dashboard-licence-alert-${alert.vehicle_id}`}>
                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-800">{alert.registration || alert.vehicle_name}</span><span className="text-xs text-slate-500">Expires {fmtDate(alert.expiry_date)}</span></span>
                <Badge cls={alert.status === "EXPIRED" ? "bg-red-50 text-red-700 border-red-200" : "bg-amber-50 text-amber-700 border-amber-200"}>{alert.status === "EXPIRED" ? "Expired" : `${alert.days_remaining} days left`}</Badge>
              </button>)}
            </div>}
          </Card>
        </section>
      )}

      <section aria-labelledby="dashboard-operations-heading">
        <h2 id="dashboard-operations-heading" className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Period Activity &amp; Current Operations</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {[[`Done ${periodLabel}`, d.completed_today, "/orders"],
            [`Orders to Send · ${periodLabel}`, d.orders_open_count, "/orders"], [`Urgent Orders · ${periodLabel}`, d.urgent_orders, "/orders"], ["Vehicles Free", `${d.vehicles_available}/${d.vehicles_total}`, "/fleet"],
            ["Maintenance Due", d.maintenance_due, "/fleet"]].map(([l, v, to]) => (
            <button key={l} onClick={() => nav(to)} className="premium-button rounded-lg border border-border bg-white/85 p-3 text-left hover:border-primary/50 hover:bg-white transition-colors" data-testid={`op-kpi-${l.toLowerCase().replace(/\s/g, "-")}`}>
              <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">{l}</p><p className="text-xl font-semibold font-mono tabular-nums text-slate-800 mt-1">{v}</p>
            </button>))}
        </div>
      </section>

      {/* Quick actions */}
      <Card className="premium-card p-5">
        <h3 className="font-bold text-slate-800 mb-4 font-display">Quick Actions</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {QUICK.filter((q) => !(user?.company_id === MANUFACTURING_COMPANY_ID && q.to === "/production?add=1")).map((q) => (
            <button key={q.label} onClick={() => nav(q.to)} data-testid={`quick-${q.label.toLowerCase().replace(/\s/g, "-")}`}
              className="premium-button flex flex-col items-center gap-2 rounded-lg border border-border bg-white/70 p-4 hover:border-primary/50 hover:bg-accent/35 transition-colors">
              <q.icon size={19} strokeWidth={1.8} className="text-primary" />
              <span className="text-xs font-semibold text-slate-700 text-center">{q.label}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title={`Orders to Send · ${periodLabel}`} icon={ClipboardList} action={<button onClick={() => nav("/orders")} className="text-xs font-semibold text-primary flex items-center gap-1" data-testid="dash-orders-view">View <ArrowRight size={12} /></button>}>
          {d.orders_to_send?.length ? (
            <div className="space-y-2">{d.orders_to_send.map((o) => (
              <div key={o.id} className="flex justify-between rounded-lg border border-border px-3 py-2" data-testid={`dash-order-${o.id}`}>
                <span className="text-sm font-semibold text-slate-700">{o.customer_name || "-"} <span className="text-slate-400 font-normal">· {o.destination}</span></span>
                <Badge cls={o.priority === "Urgent" || o.priority === "High" ? "bg-red-50 text-red-700 border-red-200" : "bg-slate-100 text-slate-600 border-slate-200"}>{o.priority} · {o.status}</Badge>
              </div>))}</div>
          ) : empty("No orders waiting to be sent.")}
        </Section>

        <Section title={`Deliveries · ${periodLabel}`} icon={Truck}>
          {d.upcoming_deliveries?.length ? (
            <div className="space-y-2">{d.upcoming_deliveries.map((delivery) => (
              <div key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2" data-testid={`dash-delivery-${delivery.id}`}>
                <span className="text-sm font-semibold text-slate-700">
                  {delivery.customer_name || delivery.destination || "Delivery"}
                  {delivery.destination && delivery.customer_name && <span className="font-normal text-slate-400"> · {delivery.destination}</span>}
                </span>
                <span className="text-xs text-slate-500">{fmtDate(delivery.planned_departure)} · {delivery.status}</span>
              </div>
            ))}</div>
          ) : empty(`No deliveries scheduled for ${periodLabel.toLowerCase()}.`)}
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

        <Section title="Current Production Recommendations" icon={TrendingUp}>
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

        <Section title={`Attendance · ${periodLabel}`} icon={CalendarCheck} action={<button onClick={() => nav("/attendance")} className="text-xs font-semibold text-primary flex items-center gap-1">View <ArrowRight size={12} /></button>}>
          {d.attendance_today.length === 0 ? empty(`No attendance recorded for ${periodLabel.toLowerCase()}.`) : (
            <div className="space-y-2">{d.attendance_today.map((a) => (
              <div key={a.id} className="flex justify-between rounded-lg border border-border px-3 py-2">
                <span className="text-sm font-semibold text-slate-700">{a.employee_name}</span><Badge cls="bg-slate-100 text-slate-600 border-slate-200">{a.status}</Badge>
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

      <Section title={`Invoices · ${periodLabel}`} icon={Receipt} action={<button onClick={() => nav("/invoices")} className="text-xs font-semibold text-primary flex items-center gap-1">View all <ArrowRight size={12} /></button>}>
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
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Total Invoiced</dt><dd className="font-mono font-semibold">{fmtMoney(entry.total_invoiced)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Revenue</dt><dd className="font-mono font-semibold">{fmtMoney(entry.revenue)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Buyings</dt><dd className="font-mono">{fmtMoney(entry.buyings)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">GRV Purchases</dt><dd className="font-mono">{fmtMoney(entry.grv_expenses)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Salaries</dt><dd className="font-mono">{fmtMoney(entry.salaries)}</dd></div>
                      <div className="flex justify-between gap-2"><dt className="text-slate-500">Expenses</dt><dd className="font-mono">{fmtMoney(entry.expenses)}</dd></div>
                      <div className="flex justify-between gap-2 border-t border-border pt-2"><dt className="font-semibold text-slate-700">Final Profit</dt><dd className="font-mono font-bold">{fmtMoney(entry.profit)}</dd></div>
                    </dl>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-primary/15 bg-primary/5 px-4 py-3 text-sm">
                <span className="font-semibold text-slate-700">Difference (second − first): </span>
                Total Invoiced {comparisonDifference(comparisonResult.second.total_invoiced, comparisonResult.first.total_invoiced)} ·
                Revenue {comparisonDifference(comparisonResult.second.revenue, comparisonResult.first.revenue)} ·
                Buyings {comparisonDifference(comparisonResult.second.buyings, comparisonResult.first.buyings)} ·
                GRV Purchases {comparisonDifference(comparisonResult.second.grv_expenses, comparisonResult.first.grv_expenses)} ·
                Salaries {comparisonDifference(comparisonResult.second.salaries, comparisonResult.first.salaries)} ·
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
