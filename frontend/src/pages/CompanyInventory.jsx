import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Boxes, Pencil, Plus, Trash2 } from "lucide-react";
import { Btn, Card, Empty, Input, Modal, PageHeader } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";

const CATEGORIES = ["Glue", "Solo Tape", "Fabric Roll", "Ribbon", "Cotton"];
const PACKAGINGS = ["Box", "Carton", "Pallet", "Roll", "Drum"];
const UNITS = ["pcs", "rolls", "kg", "L", "m"];
const OTHER = "__other__";
const fmt = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const blank = {
  name: "", category: CATEGORIES[0], categoryCustom: "", size: "",
  packaged: false, packaging: PACKAGINGS[0], packagingCustom: "",
  packages: "", units_per_package: "", loose_units: "",
  unit: UNITS[0], unitCustom: "", notes: "",
};

function Choice({ label, options, value, custom, onValue, onCustom, testId }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 mb-1">{label}</label>
      <select className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={value} onChange={(event) => onValue(event.target.value)} data-testid={testId}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
        <option value={OTHER}>Other (type manually)</option>
      </select>
      {value === OTHER && (
        <input className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" placeholder={`Enter ${label.toLowerCase()}`} value={custom} onChange={(event) => onCustom(event.target.value)} />
      )}
    </div>
  );
}

const pick = (list, value) => (list.includes(value) ? { v: value, c: "" } : { v: OTHER, c: value });

export default function CompanyInventory() {
  const { user } = useAuth();
  const canDelete = !user?.is_worker && (user?.is_owner || user?.is_company_owner);
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const load = () => api.getUncached("/company-inventory")
    .then(setItems)
    .catch((error) => { toast.error(apiError(error)); setItems([]); });
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => [...new Set([...CATEGORIES, ...(items || []).map((item) => item.category)])], [items]);
  const visible = (items || []).filter((item) => !filter || item.category === filter);

  const openAdd = () => { setEditId(null); setForm({ ...blank }); };
  const openEdit = (item) => {
    const cat = pick(categories, item.category);
    const pack = pick(PACKAGINGS, item.packaging);
    const unit = pick(UNITS, item.unit);
    setEditId(item.id);
    setForm({
      name: item.name, category: cat.v, categoryCustom: cat.c, size: item.size,
      packaged: item.packages > 0 || !!item.packaging, packaging: item.packaging ? pack.v : PACKAGINGS[0], packagingCustom: item.packaging ? pack.c : "",
      packages: String(item.packages || ""), units_per_package: String(item.units_per_package || ""), loose_units: String(item.loose_units || ""),
      unit: unit.v, unitCustom: unit.c, notes: item.notes || "",
    });
  };

  const save = async () => {
    const category = (form.category === OTHER ? form.categoryCustom : form.category).trim();
    const unit = (form.unit === OTHER ? form.unitCustom : form.unit).trim();
    const packaging = form.packaged ? (form.packaging === OTHER ? form.packagingCustom : form.packaging).trim() : "";
    const num = (value) => (value === "" ? 0 : Number(value));
    const packages = form.packaged ? num(form.packages) : 0;
    const units_per_package = 0;
    const loose_units = num(form.loose_units);
    if (!form.name.trim()) return toast.error("Enter the product name");
    if (!category) return toast.error("Enter the category");
    if (!unit) return toast.error("Enter the unit of measure");
    if (form.packaged && !packaging) return toast.error("Enter the package type");
    if ([packages, units_per_package, loose_units].some((value) => !Number.isFinite(value) || value < 0)) return toast.error("Enter valid quantities");
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), category, size: form.size.trim(), packaging, packages, units_per_package, loose_units, unit, notes: form.notes.trim() };
      if (editId) await api.put(`/company-inventory/${editId}`, payload);
      else await api.post("/company-inventory", payload);
      toast.success(editId ? "Product updated" : "Product added");
      setForm(null);
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.name}${item.size ? ` ${item.size}` : ""}?`)) return;
    try {
      await api.del(`/company-inventory/${item.id}`);
      toast.success("Product deleted");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const preview = Number(form?.loose_units || 0);

  return (
    <div data-testid="company-inventory-page">
      <PageHeader title="Company Inventory" subtitle="Resources used by the company: glue, tape, fabric rolls, ribbon, cotton and more.">
        <Btn onClick={openAdd} data-testid="add-inventory-product-btn"><Plus size={16} /> Add Product</Btn>
      </PageHeader>

      <Card className="p-4 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-3">Totals by category</h2>
        {items === null ? <p className="text-sm text-slate-400">Loading...</p> : items.length === 0 ? <p className="text-sm text-slate-400">No products yet.</p> : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {categories.filter((cat) => items.some((item) => item.category === cat)).map((cat) => {
              const byUnit = new Map();
              items.filter((item) => item.category === cat).forEach((item) => byUnit.set(item.unit, (byUnit.get(item.unit) || 0) + Number(item.total || 0)));
              return (
                <div key={cat} className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-slate-500">{cat}</p>
                  <p className="font-mono text-sm font-bold text-slate-800">{[...byUnit].map(([unit, qty]) => `${fmt(qty)} ${unit}`).join(" · ")}</p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-end justify-between gap-3 mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600">Products</h2>
          <select className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter by category" data-testid="inventory-filter">
            <option value="">All categories</option>
            {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </div>
        {items === null ? <p className="text-sm text-slate-400">Loading...</p> : visible.length === 0 ? <Empty icon={Boxes} title="No products" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Product</th><th>Category</th><th>Size</th><th>Packaging</th><th className="text-right">Loose</th><th className="text-right">Total</th><th /></tr></thead>
              <tbody>{visible.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="py-2 font-semibold text-slate-800">{item.name}</td>
                  <td>{item.category}</td>
                  <td className="font-mono">{item.size || "-"}</td>
                  <td>{item.packages > 0 ? `${fmt(item.packages)} ${item.packaging}` : "-"}</td>
                  <td className="text-right font-mono">{item.loose_units > 0 ? `${fmt(item.loose_units)} ${item.unit}` : "-"}</td>
                  <td className="text-right font-mono font-bold">{fmt(item.total)} {item.unit}</td>
                  <td className="text-right whitespace-nowrap">
                    <Btn variant="outline" onClick={() => openEdit(item)} aria-label="Edit product"><Pencil size={14} /></Btn>
                    {canDelete && <Btn variant="outline" className="ml-1" onClick={() => remove(item)} aria-label="Delete product"><Trash2 size={14} /></Btn>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!form} onClose={() => setForm(null)} title={editId ? "Edit Product" : "Add Product"}>
        {form && <div className="space-y-4">
          <Input label="Product name *" value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Glue, Solo Tape" data-testid="inventory-name" />
          <div className="grid grid-cols-2 gap-3 items-start">
            <Choice label="Category" options={categories} value={form.category} custom={form.categoryCustom} onValue={(category) => set({ category })} onCustom={(categoryCustom) => set({ categoryCustom })} testId="inventory-category" />
            <Input label="Size (optional)" value={form.size} onChange={(event) => set({ size: event.target.value })} placeholder="e.g. 34, 32" data-testid="inventory-size" />
          </div>
          <Choice label="Unit of measure" options={UNITS} value={form.unit} custom={form.unitCustom} onValue={(unit) => set({ unit })} onCustom={(unitCustom) => set({ unitCustom })} testId="inventory-unit" />
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={form.packaged} onChange={(event) => set({ packaged: event.target.checked })} data-testid="inventory-packaged" />
            This product comes in boxes / packages
          </label>
          {form.packaged && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start rounded-md border border-slate-200 bg-slate-50 p-3">
              <Choice label="Package type" options={PACKAGINGS} value={form.packaging} custom={form.packagingCustom} onValue={(packaging) => set({ packaging })} onCustom={(packagingCustom) => set({ packagingCustom })} testId="inventory-packaging" />
              <Input label="Number of packages" type="number" min="0" step="any" value={form.packages} onChange={(event) => set({ packages: event.target.value })} data-testid="inventory-packages" />
            </div>
          )}
          <Input label={form.packaged ? "Quantity" : "Quantity"} type="number" min="0" step="any" value={form.loose_units} onChange={(event) => set({ loose_units: event.target.value })} data-testid="inventory-loose" />
          <Input label="Notes (optional)" value={form.notes} onChange={(event) => set({ notes: event.target.value })} />
          <p className="text-xs text-slate-500">Total: <span className="font-mono font-bold text-slate-800">{fmt(preview)} {form.unit === OTHER ? form.unitCustom : form.unit}</span></p>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setForm(null)}>Cancel</Btn><Btn disabled={saving} onClick={save} data-testid="inventory-save">{saving ? "Saving..." : "Save"}</Btn></div>
        </div>}
      </Modal>
    </div>
  );
}
