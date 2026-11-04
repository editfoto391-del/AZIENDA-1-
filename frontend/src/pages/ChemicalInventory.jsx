import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Boxes, Plus, Trash2 } from "lucide-react";
import { Btn, Card, Empty, Input, PageHeader } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";

const CONTAINER_TYPES = ["Barrel", "Container"];
const CAPACITIES = ["25", "50", "100", "200", "210", "1000"];
const UNITS = ["L", "kg", "mL", "g", "gal"];
const OTHER = "__other__";
const fmt = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function Choice({ label, options, value, custom, onValue, onCustom, type = "text", testId }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 mb-1">{label}</label>
      <select className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={value} onChange={(event) => onValue(event.target.value)} data-testid={testId}>
        <option value="">Select {label.toLowerCase()}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
        <option value={OTHER}>Other (type manually)</option>
      </select>
      {value === OTHER && (
        <input className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "any" : undefined}
          placeholder={`Enter ${label.toLowerCase()}`} value={custom} onChange={(event) => onCustom(event.target.value)} />
      )}
    </div>
  );
}

const blank = { chemical: "", type: CONTAINER_TYPES[0], typeCustom: "", capacity: "", capacityCustom: "", unit: "", unitCustom: "", count: "" };

export default function ChemicalInventory() {
  const { user } = useAuth();
  const canDelete = !user?.is_worker && (user?.is_owner || user?.is_company_owner);
  const canSetMinimum = user?.is_worker
    ? user?.is_supervisor
    : !!(user?.is_owner || user?.is_admin || user?.is_company_owner);
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(blank);
  const [minimumDrafts, setMinimumDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const load = () => api.getUncached("/warehouses/chemical/inventory")
    .then(setItems)
    .catch((error) => { toast.error(apiError(error)); setItems([]); });
  useEffect(() => { load(); }, []);

  const totals = useMemo(() => {
    const map = new Map();
    (items || []).forEach((item) => {
      const key = `${item.chemical.toLowerCase()}|${item.unit.toLowerCase()}`;
      const entry = map.get(key) || {
        chemical: item.chemical, unit: item.unit, total: 0, containers: 0,
        low_stock: false, minimum_stock: item.minimum_stock ?? null,
      };
      entry.total += Number(item.available_quantity ?? item.capacity * item.count);
      entry.containers += item.count;
      entry.low_stock ||= item.low_stock;
      if (item.minimum_stock != null) entry.minimum_stock = item.minimum_stock;
      map.set(key, entry);
    });
    return [...map.values()].sort((a, b) => a.chemical.localeCompare(b.chemical));
  }, [items]);

  const save = async () => {
    const container_type = form.type === OTHER ? form.typeCustom.trim() : form.type;
    const capacity = Number(form.capacity === OTHER ? form.capacityCustom : form.capacity);
    const unit = form.unit === OTHER ? form.unitCustom.trim() : form.unit;
    const count = Number(form.count);
    if (!form.chemical.trim()) return toast.error("Enter the chemical name");
    if (!container_type) return toast.error("Enter the container type");
    if (!Number.isFinite(capacity) || capacity <= 0) return toast.error("Enter a valid capacity");
    if (!unit) return toast.error("Enter the unit of measure");
    if (!Number.isFinite(count) || count < 0) return toast.error("Enter a valid number of containers");
    setSaving(true);
    try {
      await api.post("/warehouses/chemical/inventory", { chemical: form.chemical.trim(), container_type, capacity, unit, count });
      toast.success("Verified stock quantity recorded");
      setForm({ ...blank, chemical: "" });
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.chemical} (${item.count} x ${item.container_type})?`)) return;
    try {
      await api.del(`/warehouses/chemical/inventory/${item.id}`);
      toast.success("Entry deleted");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const saveMinimum = async (row) => {
    const key = `${row.chemical}|${row.unit}`;
    const value = Number(minimumDrafts[key] ?? row.minimum_stock ?? 0);
    if (!Number.isFinite(value) || value < 0) return toast.error("Enter a valid minimum stock quantity");
    try {
      await api.put("/warehouses/chemical/inventory/minimum", {
        chemical: row.chemical,
        unit: row.unit,
        minimum_quantity: value,
      });
      toast.success("Minimum stock updated");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div data-testid="chemical-inventory-page">
      <PageHeader title="Chemical Inventory" subtitle="Verified chemical stock, quantity thresholds and usage-linked inventory movements." />

      <Card className="p-5 mb-6">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3"><Boxes size={16} /> Registered chemicals ({totals.length})</h2>
        {items === null ? <p className="text-slate-400 text-sm">Loading...</p> : totals.length === 0 ? <Empty>No stock recorded yet.</Empty> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Chemical</th><th>Available stock</th><th>Minimum</th><th>Stock value</th><th>Status</th></tr></thead>
            <tbody>{totals.map((row) => (
              <tr key={`${row.chemical}|${row.unit}`} className="border-b last:border-0">
                <td className="py-2 font-semibold text-slate-800">{row.chemical}</td>
                <td className="font-semibold">{fmt(row.total)} {row.unit}</td>
                <td>
                  {canSetMinimum ? <div className="flex items-center gap-2">
                    <Input label="Minimum" aria-label={`Minimum stock for ${row.chemical}`} type="number" min="0" step="any"
                      value={minimumDrafts[`${row.chemical}|${row.unit}`] ?? row.minimum_stock ?? ""}
                      onChange={(event) => setMinimumDrafts((current) => ({ ...current, [`${row.chemical}|${row.unit}`]: event.target.value }))}
                      placeholder="Not set" />
                    <Btn variant="outline" onClick={() => saveMinimum(row)}>Save</Btn>
                  </div> : row.minimum_stock == null ? "Not set" : `${fmt(row.minimum_stock)} ${row.unit}`}
                </td>
                <td className="text-slate-500">Not configured</td>
                <td>{row.total <= 0
                  ? <span className="font-semibold text-slate-500">NO STOCK</span>
                  : row.low_stock
                  ? <span className="whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">LOW STOCK · {fmt(row.total)} / {fmt(row.minimum_stock ?? 0)} {row.unit}</span>
                  : <span className="text-emerald-700">In stock</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>

      <Card className="p-5 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">Record verified opening stock</h2>
        <p className="mb-3 text-xs text-slate-500">Enter only the real available quantity. This records a stock-opening movement and does not create purchase or supplier data.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <Input label="Chemical" value={form.chemical} onChange={(event) => set({ chemical: event.target.value })} data-testid="inventory-chemical" />
          <Choice label="Type" options={CONTAINER_TYPES} value={form.type} custom={form.typeCustom} onValue={(type) => set({ type })} onCustom={(typeCustom) => set({ typeCustom })} testId="inventory-type" />
          <Choice label="Capacity" options={CAPACITIES} type="number" value={form.capacity} custom={form.capacityCustom} onValue={(capacity) => set({ capacity })} onCustom={(capacityCustom) => set({ capacityCustom })} testId="inventory-capacity" />
          <Choice label="Unit of measure" options={UNITS} value={form.unit} custom={form.unitCustom} onValue={(unit) => set({ unit })} onCustom={(unitCustom) => set({ unitCustom })} testId="inventory-unit" />
          <Input label="Number of containers" type="number" min="0" step="any" value={form.count} onChange={(event) => set({ count: event.target.value })} data-testid="inventory-count" />
        </div>
        <div className="mt-4"><Btn onClick={save} disabled={saving} data-testid="inventory-save"><Plus size={15} /> {saving ? "Saving..." : "Record stock"}</Btn></div>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">Entries</h2>
        {items === null ? <p className="text-slate-400 text-sm">Loading...</p> : items.length === 0 ? <Empty>No entries.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Chemical</th><th>Type</th><th>Capacity</th><th>Count</th><th>Quantity</th><th /></tr></thead>
              <tbody>{items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="py-2 font-semibold text-slate-800">{item.chemical}</td>
                  <td>{item.container_type}</td>
                  <td>{fmt(item.capacity)} {item.unit}</td>
                  <td>{fmt(item.count)}</td>
                  <td>{fmt(item.available_quantity ?? item.capacity * item.count)} {item.unit}</td>
                  <td className="text-right">{canDelete && <Btn variant="outline" onClick={() => remove(item)} aria-label="Delete entry"><Trash2 size={15} /></Btn>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
