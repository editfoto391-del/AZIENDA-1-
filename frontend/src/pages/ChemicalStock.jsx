import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { Btn, Card, Empty, Input, PageHeader, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";

const blankLine = () => ({ chemical: "", unit: "kg", used_quantity: "", initial_quantity: "", remaining_estimate: "" });
const fmtQty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const weekStartDate = (value) => {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export default function ChemicalStock() {
  const { user } = useAuth();
  const canDelete = !user?.is_worker && (user?.is_owner || user?.is_company_owner);
  const [logs, setLogs] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [usageFilters, setUsageFilters] = useState({ from: "", to: "", chemical: "", block_type: "", supervisor: "" });
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([blankLine()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => api.getUncached("/warehouses/chemical/logs")
    .then(setLogs)
    .catch((error) => { toast.error(apiError(error)); setLogs([]); });
  const loadInventory = () => api.getUncached("/warehouses/chemical/inventory")
    .then(setInventory)
    .catch((error) => toast.error(apiError(error)));
  useEffect(() => { load(); loadInventory(); }, []);

  // Latest estimate per chemical, from the most recent dated entry.
  const latest = useMemo(() => {
    const byChemical = new Map();
    [...(logs || [])]
      .sort((a, b) => (a.date === b.date ? String(a.created_at || "").localeCompare(String(b.created_at || "")) : a.date.localeCompare(b.date)))
      .forEach((log) => log.lines.forEach((line) => {
        byChemical.set(`${line.chemical.toLowerCase()}|${line.unit.toLowerCase()}`, { ...line, date: log.date });
      }));
    return [...byChemical.values()].sort((a, b) => a.chemical.localeCompare(b.chemical) || a.unit.localeCompare(b.unit));
  }, [logs]);

  const latestByName = useMemo(() => new Map(latest.map((item) => [`${item.chemical.toLowerCase()}|${item.unit.toLowerCase()}`, item])), [latest]);
  const usageRows = useMemo(() => (logs || []).flatMap((log) => (log.lines || []).map((line) => ({
    ...line,
    date: log.date,
    log_id: log.id,
    supervisor_name: line.supervisor_name || log.created_by_name || "—",
    production_id: line.production_id || log.production_id || null,
    is_actual_production: !!(line.production_id || log.production_id),
  }))), [logs]);
  const summarizeUsage = (startDate, endDate = today()) => {
    const totals = new Map();
    usageRows.filter((line) => line.date >= startDate && line.date <= endDate && line.is_actual_production)
      .forEach((line) => {
        const key = `${line.chemical}|${line.unit}`;
        totals.set(key, {
          chemical: line.chemical,
          unit: line.unit,
          quantity: (totals.get(key)?.quantity || 0) + Number(line.used_quantity || 0),
        });
      });
    return [...totals.values()];
  };
  const dailyUsage = summarizeUsage(today());
  const weeklyUsage = summarizeUsage(weekStartDate(today()));
  const monthlyUsage = summarizeUsage(`${today().slice(0, 7)}-01`);
  const filteredLogs = useMemo(() => (logs || []).map((log) => ({
    ...log,
    lines: (log.lines || []).filter((line) => {
      const supervisor = line.supervisor_name || log.created_by_name || "";
      return (!usageFilters.from || log.date >= usageFilters.from)
        && (!usageFilters.to || log.date <= usageFilters.to)
        && (!usageFilters.chemical || line.chemical === usageFilters.chemical)
        && (!usageFilters.block_type || line.block_type === usageFilters.block_type)
        && (!usageFilters.supervisor || supervisor === usageFilters.supervisor);
    }),
  })).filter((log) => log.lines.length), [logs, usageFilters]);
  const chemicalOptions = [...new Set(usageRows.map((line) => line.chemical).filter(Boolean))].sort();
  const blockOptions = [...new Set(usageRows.map((line) => line.block_type).filter(Boolean))].sort();
  const supervisorOptions = [...new Set(usageRows.map((line) => line.supervisor_name).filter(Boolean))].sort();

  // Remaining is calculated from the initial quantity (or the last known estimate) minus today's usage, unless typed manually.
  const calcRemaining = (line) => {
    if (line.remainingManual) return line.remaining_estimate;
    const key = `${line.chemical.trim().toLowerCase()}|${line.unit.trim().toLowerCase()}`;
    const base = line.initial_quantity !== "" ? Number(line.initial_quantity) : latestByName.get(key)?.remaining_estimate;
    if (base == null || !Number.isFinite(base)) return "";
    const result = base - (line.used_quantity === "" ? 0 : Number(line.used_quantity));
    return Number.isFinite(result) ? String(Math.round(result * 10000) / 10000) : "";
  };

  const setLine = (index, patch) => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));

  const prefill = (item) => setLines((current) => {
    const rest = current.filter((line) => line.chemical.trim());
    if (rest.some((line) => line.chemical.toLowerCase() === item.chemical.toLowerCase() && line.unit.toLowerCase() === item.unit.toLowerCase())) return current;
    return [...rest, { ...blankLine(), chemical: item.chemical, unit: item.unit }];
  });

  const save = async () => {
    const withRemaining = lines.map((line) => ({ ...line, remaining_estimate: calcRemaining(line) }));
    const filled = withRemaining.filter((line) => line.chemical.trim() || line.remaining_estimate !== "" || line.used_quantity !== "" || line.initial_quantity !== "");
    if (!filled.length) return toast.error("Add at least one chemical");
    for (const line of filled) {
      if (!line.chemical.trim()) return toast.error("Every row needs a chemical name");
      const remaining = Number(line.remaining_estimate);
      const initial = Number(line.initial_quantity);
      const used = line.used_quantity === "" ? 0 : Number(line.used_quantity);
      if (line.remaining_estimate === "") {
        return toast.error(`Enter the initial quantity or the remaining quantity for ${line.chemical}`);
      }
      if (!Number.isFinite(remaining) || remaining < 0) {
        return toast.error(`Remaining quantity for ${line.chemical} cannot be negative - check the used quantity`);
      }
      if (line.initial_quantity !== "" && (!Number.isFinite(initial) || initial < 0)) {
        return toast.error(`Enter a valid initial quantity for ${line.chemical}`);
      }
      if (!Number.isFinite(used) || used < 0) return toast.error(`Enter a valid used quantity for ${line.chemical}`);
    }
    setSaving(true);
    try {
      await api.post("/warehouses/chemical/logs", {
        date,
        notes,
        lines: filled.map((line) => ({
          chemical: line.chemical.trim(),
          unit: line.unit.trim() || "kg",
          used_quantity: line.used_quantity === "" ? 0 : Number(line.used_quantity),
          initial_quantity: line.initial_quantity === "" ? null : Number(line.initial_quantity),
          remaining_estimate: Number(line.remaining_estimate),
        })),
      });
      toast.success("Chemical estimate saved");
      setLines([blankLine()]);
      setNotes("");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (log) => {
    if (!window.confirm(`Delete the chemical entry of ${log.date}? This cannot be undone.`)) return;
    try {
      await api.del(`/warehouses/chemical/logs/${log.id}`);
      toast.success("Entry deleted");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div data-testid="chemical-page">
      <PageHeader title="Chemical Usage Log" subtitle="Review confirmed production consumption and record daily usage estimates. Manual estimates do not change stock; confirmed production deducts from Chemical Inventory." />

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-yellow-600">Confirmed production consumption</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {[["Today", dailyUsage], ["This week", weeklyUsage], ["This month", monthlyUsage]].map(([label, rows]) => (
            <div key={label} className="rounded-md border border-slate-200 p-3" data-testid={`chemical-usage-${label.toLowerCase().replace(" ", "-")}`}>
              <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
              {rows.length
                ? rows.map((row) => <p key={`${row.chemical}|${row.unit}`} className="mt-1 text-sm text-slate-700">{row.chemical}: <b>{fmtQty(row.quantity)} {row.unit}</b></p>)
                : <p className="mt-1 text-sm text-slate-400">No confirmed production usage</p>}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-yellow-600">Current chemical inventory</h2>
        {inventory.length === 0 ? <Empty title="No inventory quantities recorded." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">Chemical</th><th>Available</th><th>Minimum</th><th>Status</th></tr></thead>
              <tbody>{inventory.map((item) => <tr key={item.id} className="border-b last:border-0">
                <td className="py-2 font-semibold">{item.chemical}</td>
                <td>{fmtQty(item.available_quantity)} {item.unit}</td>
                <td>{item.minimum_stock == null ? "Not set" : `${fmtQty(item.minimum_stock)} ${item.unit}`}</td>
                <td>{Number(item.available_quantity) <= 0
                  ? <span className="font-semibold text-slate-500">NO STOCK</span>
                  : item.low_stock
                    ? <span className="font-semibold text-amber-700">LOW STOCK</span>
                    : <span className="text-emerald-700">In stock</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 mb-6">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3"><FlaskConical size={16} /> Current estimated chemical stock</h2>
        {logs === null ? <p className="text-slate-400 text-sm">Loading...</p> : latest.length === 0 ? <Empty>No chemical estimates recorded yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Chemical</th><th>Estimated remaining</th><th>Last updated</th><th /></tr></thead>
              <tbody>{latest.map((item) => (
                <tr key={`${item.chemical}|${item.unit}`} className="border-b last:border-0">
                  <td className="py-2 font-semibold text-slate-800">{item.chemical}</td>
                  <td>
                    {fmtQty(item.remaining_estimate)} {item.unit}
                    {item.low_stock && <span className="ml-2 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Low stock</span>}
                  </td>
                  <td className="text-slate-500">{item.date}</td>
                  <td className="text-right"><Btn variant="outline" onClick={() => prefill(item)}>Update</Btn></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">Daily update</h2>
        <p className="mb-3 text-xs text-slate-500">Manual estimates are history only. Use Chemical Inventory to register verified stock; only confirmed production creates a stock deduction.</p>
        <div className="max-w-xs mb-4"><Input label="Production date" type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} data-testid="chemical-date" /></div>
        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className="grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-3 items-end">
              <div className="col-span-2 md:col-span-1"><Input label="Chemical" value={line.chemical} onChange={(event) => setLine(index, { chemical: event.target.value })} data-testid={`chemical-name-${index}`} /></div>
              <Input label="Unit" value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })} />
              <Input label="Initial quantity (optional)" type="number" min="0" step="any" value={line.initial_quantity} onChange={(event) => setLine(index, { initial_quantity: event.target.value })} data-testid={`chemical-initial-${index}`} />
              <Input label="Used today" type="number" min="0" step="any" value={line.used_quantity} onChange={(event) => setLine(index, { used_quantity: event.target.value })} />
              <Input label="Remaining (auto, editable)" type="number" min="0" step="any" value={calcRemaining(line)} onChange={(event) => setLine(index, { remaining_estimate: event.target.value, remainingManual: event.target.value !== "" })} data-testid={`chemical-remaining-${index}`} />
              <Btn variant="outline" onClick={() => setLines((current) => current.length > 1 ? current.filter((_, i) => i !== index) : [blankLine()])} aria-label="Remove row"><Trash2 size={15} /></Btn>
            </div>
          ))}
        </div>
        <div className="mt-3"><Btn variant="outline" onClick={() => setLines((current) => [...current, blankLine()])}><Plus size={15} /> Add chemical</Btn></div>
        <div className="mt-4"><Input label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
        <div className="mt-4 flex justify-end"><Btn disabled={saving} onClick={save} data-testid="chemical-save"><Save size={16} /> {saving ? "Saving..." : "Save daily update"}</Btn></div>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">Chemical usage history and filters</h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input label="From" type="date" value={usageFilters.from} onChange={(event) => setUsageFilters((current) => ({ ...current, from: event.target.value }))} />
          <Input label="To" type="date" value={usageFilters.to} onChange={(event) => setUsageFilters((current) => ({ ...current, to: event.target.value }))} />
          <Select label="Chemical" value={usageFilters.chemical} onChange={(event) => setUsageFilters((current) => ({ ...current, chemical: event.target.value }))}>
            <option value="">All chemicals</option>
            {chemicalOptions.map((chemical) => <option key={chemical} value={chemical}>{chemical}</option>)}
          </Select>
          <Select label="Block type" value={usageFilters.block_type} onChange={(event) => setUsageFilters((current) => ({ ...current, block_type: event.target.value }))}>
            <option value="">All block types</option>
            {blockOptions.map((block) => <option key={block} value={block}>{block}</option>)}
          </Select>
          <Select label="Supervisor" value={usageFilters.supervisor} onChange={(event) => setUsageFilters((current) => ({ ...current, supervisor: event.target.value }))}>
            <option value="">All supervisors</option>
            {supervisorOptions.map((supervisor) => <option key={supervisor} value={supervisor}>{supervisor}</option>)}
          </Select>
        </div>
        {logs === null ? null : logs.length === 0 ? <Empty title="No entries yet." /> : (
          filteredLogs.length === 0 ? <Empty title="No usage matches these filters." /> : <div className="space-y-3">
            {filteredLogs.map((log) => (
              <div key={log.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="font-semibold text-slate-800">{log.date} <span className="text-xs font-normal text-slate-400">by {log.created_by_name || "—"}</span></div>
                  {log.production_id
                    ? <span className="text-xs font-semibold text-emerald-700">Confirmed production · stock deducted</span>
                    : <span className="text-xs font-semibold text-slate-500">Manual estimate · stock not deducted</span>}
                  {canDelete && <Btn variant="outline" onClick={() => remove(log)}><Trash2 size={14} /> Delete</Btn>}
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500"><th>Chemical</th><th>Initial</th><th>Used</th><th>Estimated remaining</th><th>Production reference</th><th>Block type / quantity</th><th>Supervisor</th><th>Chemical movements</th><th>Cost</th></tr></thead>
                  <tbody>{log.lines.map((line, index) => (
                    <tr key={index}>
                      <td>{line.chemical}</td>
                      <td>{line.initial_quantity != null ? `${fmtQty(line.initial_quantity)} ${line.unit}` : "—"}</td>
                      <td>{fmtQty(line.used_quantity)} {line.unit}</td>
                      <td>{line.remaining_estimate != null ? `${fmtQty(line.remaining_estimate)} ${line.unit}` : "—"}</td>
                      <td>{line.production_reference || "—"}</td>
                      <td>{line.block_type ? `${line.block_type} × ${line.block_quantity}` : "—"}</td>
                      <td>{line.supervisor_name || log.created_by_name || "—"}</td>
                      <td>{line.movement_ids?.length ? line.movement_ids.length : "—"}</td>
                      <td>{line.component_cost != null ? `R ${fmtQty(line.component_cost)}` : "Not provided"}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {log.notes && <p className="mt-2 text-xs text-slate-500">{log.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
