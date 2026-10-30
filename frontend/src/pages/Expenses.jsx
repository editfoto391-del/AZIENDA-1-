import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDate, fmtDateTime, today } from "@/lib/format";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Banknote, Eye, Plus, TrendingUp, TrendingDown, Wallet, Trash2, Pencil } from "lucide-react";

const CATS = ["General", "Materials", "Fuel", "Diesel", "Salaries", "Rent", "Utilities", "Vehicle", "Maintenance", "Other"];
const blank = () => ({ description: "", amount: "", date: today(), category: "General", payment_method: "Cash", reference: "", vehicle_id: "", notes: "" });

function Stat({ label, value, icon: Icon, tone, testid }) {
  return (
    <Card className="p-5" data-testid={testid}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-slate-900 mt-2 font-mono">{value}</p>
        </div>
        <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${tone}`}><Icon size={22} /></div>
      </div>
    </Card>
  );
}

function ProfitPanel({ title, p, testid }) {
  const neg = (p?.profit || 0) < 0;
  return (
    <Card className="p-5" data-testid={testid}>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">{title}</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-slate-500">Revenue (payments)</span><span className="font-mono text-emerald-700">{fmtMoney(p?.revenue)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Expenses</span><span className="font-mono text-orange-600">- {fmtMoney(p?.expenses)}</span></div>
        <div className="flex justify-between border-t border-border pt-2 mt-2"><span className="font-bold text-slate-800">Estimated Result</span><span className={`font-mono font-bold ${neg ? "text-red-600" : "text-slate-900"}`}>{fmtMoney(p?.profit)}</span></div>
      </div>
    </Card>
  );
}

export default function Expenses() {
  const [list, setList] = useState(null);
  const [report, setReport] = useState(null);
  const [costs, setCosts] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [modal, setModal] = useState(null);
  const [viewExpense, setViewExpense] = useState(null);
  const [cat, setCat] = useState("");
  const [month, setMonth] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [supervisorPassword, setSupervisorPassword] = useState("");

  const load = () => {
    api.get("/expenses").then(setList).catch((e) => { toast.error(apiError(e)); setList([]); });
    api.get("/reports/profit").then(setReport); api.get("/reports/costs").then(setCosts);
  };
  useEffect(() => { load(); api.get("/vehicles").then(setVehicles); }, []);

  const filtered = useMemo(() => (list || []).filter((e) => (!cat || e.category === cat) && (!month || (e.date || "").startsWith(month)) && (!q || `${e.description} ${e.reference || ""}`.toLowerCase().includes(q.toLowerCase()))), [list, cat, month, q]);
  const filteredTotal = filtered.reduce((s, e) => s + (e.amount || 0), 0);

  const save = async () => {
    if (!modal.description.trim()) return toast.error("Description required");
    if (!(Number(modal.amount) > 0)) return toast.error("Amount must be greater than 0");
    if (busy) return;
    const reason = modal.id ? window.prompt("Reason for this expense change (required):") : "";
    if (modal.id && reason === null) return;
    if (modal.id && !reason.trim()) return toast.error("A reason is required to edit an expense");
    setPendingAction({ action: modal.id ? "edit" : "create", expense: { ...modal }, reason: reason?.trim() || "" });
  };

  const remove = async (e) => {
    const reason = window.prompt(`Void expense "${e.description}" (${fmtMoney(e.amount)})? It stays in history. Reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    setPendingAction({ action: "void", expense: e, reason: reason.trim() });
  };

  const authorizeAction = async (event) => {
    event.preventDefault();
    if (!pendingAction || !supervisorPassword || busy) return;
    setBusy(true);
    try {
      const { action, expense, reason } = pendingAction;
      const approval = action === "create"
        ? await api.post("/expenses/authorize-create", { password: supervisorPassword })
        : await api.post(`/expenses/${expense.id}/authorize-action`, { password: supervisorPassword, action });
      const supervisor_authorization = approval.authorization_id;
      if (action === "void") {
        await api.post(`/expenses/${expense.id}/void`, { reason, supervisor_authorization });
        toast.success("Expense voided");
      } else {
        const payload = {
          ...expense,
          amount: Number(expense.amount),
          edit_reason: reason,
          supervisor_authorization,
        };
        if (action === "edit") await api.put(`/expenses/${expense.id}`, payload);
        else await api.post("/expenses", payload);
        toast.success("Expense saved");
        setModal(null);
      }
      setPendingAction(null);
      setSupervisorPassword("");
      load();
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Expenses" subtitle="Daily expenses and profit overview">
        <Btn onClick={() => setModal(blank())} data-testid="add-expense-btn"><Plus size={16} /> Add Expense</Btn>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="Expenses Today" value={fmtMoney(report?.today?.expenses)} icon={TrendingDown} tone="bg-orange-50 text-orange-600" testid="stat-today-expenses" />
        <Stat label="Expenses This Week" value={fmtMoney(report?.week.expenses)} icon={Wallet} tone="bg-orange-50 text-orange-600" testid="stat-week-expenses" />
        <Stat label="Expenses This Month" value={fmtMoney(report?.month.expenses)} icon={TrendingUp} tone="bg-orange-50 text-orange-600" testid="stat-month-expenses" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ProfitPanel title={`This week (from ${fmtDate(report?.week_start)})`} p={report?.week} testid="profit-week" />
        <ProfitPanel title={`This month (from ${fmtDate(report?.month_start)})`} p={report?.month} testid="profit-month" />
      </div>
      <p className="text-xs text-slate-400 -mt-3">Estimated cash result — incomplete cost data. Payments received (by payment date) − expenses paid (by expense date), including fleet costs marked Done and spare-part purchases, each counted once.</p>

      {costs && (Object.keys(costs.by_category).length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-5" data-testid="costs-by-category"><p className="text-xs font-semibold text-slate-500 uppercase mb-3">All costs by category</p>
            {Object.entries(costs.by_category).map(([k, v]) => <div key={k} className="flex justify-between text-sm py-1"><span className="text-slate-600">{k}</span><span className="font-mono">{fmtMoney(v)}</span></div>)}</Card>
          <Card className="p-5" data-testid="costs-by-vehicle"><p className="text-xs font-semibold text-slate-500 uppercase mb-3">Costs by vehicle</p>
            {Object.keys(costs.by_vehicle).length === 0 ? <p className="text-sm text-slate-400">No vehicle costs yet.</p> : Object.entries(costs.by_vehicle).map(([k, v]) => <div key={k} className="flex justify-between text-sm py-1"><span className="text-slate-600">{k}</span><span className="font-mono">{fmtMoney(v)}</span></div>)}</Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 p-4 border-b border-border">
          <div className="w-44"><Select label="Category" value={cat} onChange={(e) => setCat(e.target.value)} data-testid="expense-filter-category"><option value="">All</option>{CATS.map((c) => <option key={c}>{c}</option>)}</Select></div>
          <div className="w-44"><Input label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="expense-filter-month" /></div>
          <div className="w-56"><Input label="Search" placeholder="Description or reference" value={q} onChange={(e) => setQ(e.target.value)} data-testid="expense-search-input" /></div>
          <div className="ml-auto text-sm text-slate-500">Filtered total: <span className="font-mono font-bold text-slate-800" data-testid="expense-filtered-total">{fmtMoney(filteredTotal)}</span></div>
        </div>
        {list === null ? <p className="p-6 text-sm text-slate-400">Loading...</p> : filtered.length === 0 ? <Empty icon={Banknote} title="No expenses recorded" hint="Add your first daily expense." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="px-4 py-3 font-semibold">Date</th><th className="px-4 font-semibold">Description</th><th className="px-4 font-semibold">Category</th><th className="px-4 font-semibold text-right">Amount</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{filtered.map((e) => (
                <tr key={e.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`expense-row-${e.id}`}>
                  <td className="px-4 py-3 text-slate-500">{fmtDate(e.date)}</td>
                  <td className="px-4 font-semibold text-slate-800">{e.description}{e.source_key && <span className="ml-2 text-[10px] text-blue-600 font-semibold">{e.source_key.startsWith("monthly_business_purchase:") ? "MONTHLY PURCHASE" : "FLEET PART"}</span>}</td>
                  <td className="px-4"><Badge>{e.category}</Badge></td>
                  <td className="px-4 text-right font-mono text-slate-800">{fmtMoney(e.amount)}</td>
                  <td className="px-4 text-right whitespace-nowrap">
                    <button onClick={() => setViewExpense(e)} className="text-slate-400 hover:text-primary mr-3" title="View expense" aria-label={`View ${e.description}`} data-testid={`view-expense-${e.id}`}><Eye size={15} /></button>
                    {!e.source_key && <>
                      <button onClick={() => setModal({ ...e })} className="text-slate-400 hover:text-primary mr-3" data-testid={`edit-expense-${e.id}`}><Pencil size={15} /></button>
                      <button onClick={() => remove(e)} className="text-slate-400 hover:text-red-600" data-testid={`delete-expense-${e.id}`}><Trash2 size={15} /></button>
                    </>}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!viewExpense} onClose={() => setViewExpense(null)} title="Expense Details">
        {viewExpense && <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
          {[
            ["Description", viewExpense.description],
            ["Category", viewExpense.category],
            ["Amount", fmtMoney(viewExpense.amount)],
            ["Quantity", viewExpense.quantity],
            ["Quantity unit", viewExpense.quantity_unit],
            ["Unit price", viewExpense.unit_price ? fmtMoney(viewExpense.unit_price) : ""],
            ["Date", fmtDate(viewExpense.date)],
            ["Payment Method", viewExpense.payment_method],
            ["Reference", viewExpense.reference],
            ["Vehicle", vehicles.find((vehicle) => vehicle.id === viewExpense.vehicle_id)?.name],
            ["Notes", viewExpense.notes],
            ["Source", viewExpense.source_key?.startsWith("monthly_business_purchase:") ? "Automatic monthly purchase" : viewExpense.source_key ? "Fleet part purchase" : ""],
            ["Source Reference", viewExpense.source_key],
            ["Created", viewExpense.created_at ? fmtDateTime(viewExpense.created_at) : ""],
            ["Voided", viewExpense.voided ? "Yes" : ""],
            ["Void Reason", viewExpense.void_reason],
            ["Voided At", viewExpense.voided_at ? fmtDateTime(viewExpense.voided_at) : ""],
          ].filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => (
            <div key={label}><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-800">{value}</dd></div>
          ))}
        </dl>}
      </Modal>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? "Edit Expense" : "Add Expense"}>
        {modal && <div className="space-y-4">
          <Input label="Description *" value={modal.description} onChange={(e) => setModal({ ...modal, description: e.target.value })} data-testid="expense-description-input" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount (R) *" type="number" step="0.01" value={modal.amount} onChange={(e) => setModal({ ...modal, amount: e.target.value })} data-testid="expense-amount-input" />
            <Input label="Date" type="date" value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} data-testid="expense-date-input" />
          </div>
          <Select label="Category" value={modal.category} onChange={(e) => setModal({ ...modal, category: e.target.value })} data-testid="expense-category-select">
            {CATS.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Payment Method" value={modal.payment_method || ""} onChange={(e) => setModal({ ...modal, payment_method: e.target.value })} data-testid="expense-method-select">
              {["Cash", "Bank Transfer", "Card", "Other"].map((m) => <option key={m}>{m}</option>)}
            </Select>
            <Input label="Reference" value={modal.reference || ""} onChange={(e) => setModal({ ...modal, reference: e.target.value })} data-testid="expense-reference-input" />
          </div>
          <Select label="Related Vehicle (optional)" value={modal.vehicle_id || ""} onChange={(e) => setModal({ ...modal, vehicle_id: e.target.value })} data-testid="expense-vehicle-select">
            <option value="">None</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <p className="text-[11px] text-slate-400">Repairs & maintenance for a vehicle are recorded in Fleet — don't enter them here too.</p>
          <Input label="Notes" value={modal.notes || ""} onChange={(e) => setModal({ ...modal, notes: e.target.value })} data-testid="expense-notes-input" />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setModal(null)}>Cancel</Btn><Btn disabled={busy} onClick={save} data-testid="save-expense-btn">Save Expense</Btn></div>
        </div>}
      </Modal>
      <Modal open={!!pendingAction} onClose={() => { setPendingAction(null); setSupervisorPassword(""); }} title="Supervisor approval required">
        {pendingAction && <form onSubmit={authorizeAction} className="space-y-4" data-testid="expense-authorization-form">
          <p className="text-sm text-slate-600">Enter the supervisor password to {pendingAction.action === "create" ? "record this expense" : pendingAction.action === "edit" ? "edit this expense" : "void this expense"}. Approval is required for every user role.</p>
          <Input label="Supervisor password" type="password" autoComplete="current-password" autoFocus required value={supervisorPassword} onChange={(event) => setSupervisorPassword(event.target.value)} data-testid="expense-supervisor-password-input" />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => { setPendingAction(null); setSupervisorPassword(""); }}>Cancel</Btn>
            <Btn type="submit" disabled={busy} data-testid="authorize-expense-action-btn">{busy ? "Checking..." : "Approve action"}</Btn>
          </div>
        </form>}
      </Modal>
    </div>
  );
}
