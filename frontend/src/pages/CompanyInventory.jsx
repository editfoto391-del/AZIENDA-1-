import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Boxes, Download, Layers3, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { Btn, Card, Empty, Input, Modal, PageHeader } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";

const CATEGORIES = ["Glue", "Solo Tape", "Fabric Roll", "Ribbon", "Cotton"];
const PACKAGINGS = ["Box", "Carton", "Pallet", "Roll", "Drum"];
const UNITS = ["pcs", "rolls", "kg", "L", "m"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PLASTIC_ROLL_SIZES = ["32", "34", "36", "38", "40", "42", "45", "47", "62"];
const OTHER = "__other__";
const fmt = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function printInventorySummary(sheet) {
  if (!sheet) return false;
  const printWindow = window.open("", "_blank");
  if (!printWindow) return false;
  const styles = [...document.head.querySelectorAll('link[rel="stylesheet"], style')]
    .map((node) => node.outerHTML)
    .join("");
  printWindow.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Weekly Daily Stock Summary</title>${styles}`
    + "<style>@page{size:A4 landscape;margin:8mm}html,body{margin:0;background:#fff!important}"
    + ".company-inventory-sheet{width:100%!important;max-width:none!important;min-width:0!important;margin:0!important;"
    + "border-radius:0!important;box-shadow:none!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
    + "</style></head><body>"
    + `${sheet.outerHTML}</body></html>`,
  );
  printWindow.document.close();
  window.setTimeout(() => {
    if (printWindow.closed) return;
    printWindow.focus();
    printWindow.print();
  }, 600);
  return true;
}

const blank = {
  name: "", category: CATEGORIES[0], categoryCustom: "", size: "",
  packaged: false, packaging: PACKAGINGS[0], packagingCustom: "",
  packages: "", loose_units: "",
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
  const isSuperIqFoam = user?.company_id === "superiqfoam";
  const canEdit = !user?.is_worker;
  const canDelete = canEdit && (user?.is_owner || user?.is_company_owner);
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(null);
  const [dailyUpdate, setDailyUpdate] = useState(null);
  const [editId, setEditId] = useState(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingDailyUpdate, setSavingDailyUpdate] = useState(false);
  const [downloadingSummary, setDownloadingSummary] = useState(false);
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
      packages: String(item.packages || ""), loose_units: String(item.loose_units || ""),
      unit: unit.v, unitCustom: unit.c, notes: item.notes || "",
    });
  };

  const save = async () => {
    const category = (form.category === OTHER ? form.categoryCustom : form.category).trim();
    const unit = (form.unit === OTHER ? form.unitCustom : form.unit).trim();
    const packaging = form.packaged ? (form.packaging === OTHER ? form.packagingCustom : form.packaging).trim() : "";
    const num = (value) => (value === "" ? 0 : Number(value));
    const packages = form.packaged ? num(form.packages) : 0;
    const loose_units = num(form.loose_units);
    if (!form.name.trim()) return toast.error("Enter the product name");
    if (!category) return toast.error("Enter the category");
    if (!unit) return toast.error("Enter the unit of measure");
    if (form.packaged && !packaging) return toast.error("Enter the package type");
    if ([packages, loose_units].some((value) => !Number.isFinite(value) || value < 0)) return toast.error("Enter valid quantities");
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), category, size: form.size.trim(), packaging, packages, loose_units, unit, notes: form.notes.trim() };
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

  const openDailyUpdate = (item) => setDailyUpdate({
    item,
    date: today(),
    quantity: String(item.total ?? 0),
  });

  const saveDailyUpdate = async () => {
    const quantity = Number(dailyUpdate?.quantity);
    if (!dailyUpdate || !Number.isFinite(quantity) || quantity < 0) {
      return toast.error("Enter a valid remaining quantity");
    }
    setSavingDailyUpdate(true);
    try {
      await api.post(`/company-inventory/${dailyUpdate.item.id}/daily-update`, {
        date: dailyUpdate.date,
        quantity,
      });
      toast.success("Daily remaining quantity updated");
      setDailyUpdate(null);
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingDailyUpdate(false);
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

  const downloadInventorySummary = async () => {
    const sheet = document.getElementById("superiqfoam-weekly-stock-summary");
    if (!sheet || downloadingSummary) return;
    setDownloadingSummary(true);
    try {
      await document.fonts?.ready;
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas-pro"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(sheet, {
        scale: 2,
        backgroundColor: "#ffffff",
        logging: false,
        width: sheet.scrollWidth,
        height: sheet.scrollHeight,
        windowWidth: Math.max(document.documentElement.clientWidth, window.innerWidth),
      });
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const margin = 6;
      const scale = Math.min((297 - margin * 2) / canvas.width, (210 - margin * 2) / canvas.height);
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", (297 - width) / 2, (210 - height) / 2, width, height);
      pdf.save("superiqfoam-weekly-daily-stock-summary.pdf");
      toast.success("Stock summary PDF downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download the stock summary PDF");
    } finally {
      setDownloadingSummary(false);
    }
  };

  return (
    <div data-testid="company-inventory-page">
      <PageHeader title="Company Inventory" subtitle="Resources used by the company: glue, tape, fabric rolls, ribbon, cotton and more.">
        {canEdit && <Btn onClick={openAdd} data-testid="add-inventory-product-btn"><Plus size={16} /> Add Product</Btn>}
      </PageHeader>

      {isSuperIqFoam && (
        <section className="mb-6" aria-labelledby="weekly-stock-summary-title">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="weekly-stock-summary-title" className="text-sm font-bold text-slate-800">Weekly Daily Stock Summary</h2>
              <p className="text-xs text-slate-500">Print or download the Monday–Saturday stock check sheet.</p>
            </div>
            <div className="no-print flex gap-2">
              <Btn
                type="button"
                variant="outline"
                onClick={() => {
                  if (!printInventorySummary(document.getElementById("superiqfoam-weekly-stock-summary"))) {
                    toast.error("Allow pop-ups to print the stock summary");
                  }
                }}
                data-testid="print-weekly-stock-summary"
              >
                <Printer size={16} /> Print
              </Btn>
              <Btn
                type="button"
                onClick={downloadInventorySummary}
                disabled={downloadingSummary}
                data-testid="download-weekly-stock-summary"
              >
                <Download size={16} /> {downloadingSummary ? "Preparing..." : "Download PDF"}
              </Btn>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg">
            <div
              id="superiqfoam-weekly-stock-summary"
              className="company-inventory-sheet mx-auto min-w-[880px] max-w-[1120px] rounded-lg border border-slate-300 bg-white p-3 text-slate-900 shadow-sm"
              data-testid="weekly-stock-summary-sheet"
            >
              <header className="mb-2 grid grid-cols-[1.05fr_1.1fr_1fr] items-center gap-2">
                <div className="flex items-center gap-2 border-r-2 border-slate-300 pr-2">
                  <Layers3 size={48} strokeWidth={2.5} className="shrink-0 text-slate-900" aria-hidden="true" />
                  <div className="min-w-0">
                    <h3 className="whitespace-nowrap text-[clamp(14px,2vw,25px)] font-black leading-none tracking-tight">SUPER IQ-FOAM</h3>
                    <p className="mt-1 whitespace-nowrap text-[9px] font-bold tracking-[0.12em] text-slate-500">QUALITY · COMFORT · TRUST</p>
                  </div>
                </div>
                <div className="text-center">
                  <h3 className="rounded-md bg-[#10263e] px-2 py-1 text-[clamp(15px,2vw,24px)] font-black leading-[1.05] text-white">WEEKLY DAILY<br />STOCK SUMMARY</h3>
                  <p className="mt-1 text-[11px] font-extrabold tracking-wide">MONDAY – SATURDAY (6 DAYS)</p>
                </div>
                <div className="space-y-1 rounded-md bg-slate-100 px-2 py-1.5 text-[10px] font-bold">
                  {["WEEK START DATE:", "CHECKED BY:", "WAREHOUSE:"].map((label) => (
                    <div key={label} className="flex items-end gap-1">
                      <span className="whitespace-nowrap">{label}</span>
                      <span className="mb-0.5 min-w-0 flex-1 border-b border-slate-500" aria-hidden="true" />
                    </div>
                  ))}
                </div>
              </header>

              <table className="w-full table-fixed border-collapse text-[11px] leading-tight">
                <colgroup>
                  <col style={{ width: "24%" }} />
                  {WEEKDAYS.map((day) => <col key={day} style={{ width: "12.666%" }} />)}
                </colgroup>
                <thead>
                  <tr className="bg-[#10263e] text-white">
                    {["ITEM / SIZE", ...WEEKDAYS].map((label) => (
                      <th key={label} scope="col" className="border border-slate-400 px-1 py-2 text-center font-extrabold">
                        {label}
                        {label !== "ITEM / SIZE" && <span className="mx-auto mt-1 block w-3/4 border-b border-slate-300" />}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-[#10263e] text-white">
                    <th scope="row" className="border border-slate-500 px-2 py-1 text-left font-extrabold">
                      <span className="mr-2 inline-flex align-middle"><Layers3 size={22} aria-hidden="true" /></span> PLASTIC ROLLS
                    </th>
                    <td colSpan={WEEKDAYS.length} className="border border-slate-500" />
                  </tr>
                  {PLASTIC_ROLL_SIZES.map((size) => (
                    <tr key={size} className="h-6">
                      <th scope="row" className="border border-slate-400 bg-slate-100 px-2 text-center font-semibold">{size}</th>
                      {WEEKDAYS.map((day) => <td key={day} className="border border-slate-400 bg-white" />)}
                    </tr>
                  ))}
                  <tr className="bg-[#10263e] text-white">
                    <th scope="row" className="border border-slate-500 px-2 py-1 text-left font-extrabold">
                      <span className="mr-2 inline-flex align-middle"><Boxes size={22} aria-hidden="true" /></span> GLUE
                    </th>
                    <td colSpan={WEEKDAYS.length} className="border border-slate-500" />
                  </tr>
                  <tr className="h-6">
                    <th scope="row" className="border border-slate-400 bg-slate-100 px-2 text-left font-medium">20 Lts Glue (Box)</th>
                    {WEEKDAYS.map((day) => <td key={day} className="border border-slate-400 bg-white" />)}
                  </tr>
                  <tr className="bg-[#10263e] text-white">
                    <th scope="row" className="border border-slate-500 px-2 py-1 text-left font-extrabold">
                      <span className="mr-2 inline-flex align-middle"><Boxes size={22} aria-hidden="true" /></span> OTHER MATERIALS
                    </th>
                    <td colSpan={WEEKDAYS.length} className="border border-slate-500" />
                  </tr>
                  {["Solo Tapes", "Cotton", "Ribbon"].map((item) => (
                    <tr key={item} className="h-6">
                      <th scope="row" className="border border-slate-400 bg-slate-100 px-2 text-left font-medium">{item}</th>
                      {WEEKDAYS.map((day) => <td key={day} className="border border-slate-400 bg-white" />)}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-2 grid grid-cols-2 gap-2">
                {["NOTES / REMARKS", "STOCK ISSUES / ACTIONS REQUIRED"].map((label) => (
                  <section key={label} className="overflow-hidden rounded-md border-2 border-slate-700">
                    <h4 className="flex items-center gap-1 bg-[#10263e] px-2 py-1 text-[10px] font-extrabold text-white">
                      <AlertTriangle size={14} aria-hidden="true" /> {label}
                    </h4>
                    <div className="h-10 bg-white" />
                  </section>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

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
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Product</th><th>Category</th><th>Size</th><th>Packaging</th><th className="text-right">Loose</th><th className="text-right">Total</th><th>Last daily update</th><th /></tr></thead>
              <tbody>{visible.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="py-2 font-semibold text-slate-800">{item.name}</td>
                  <td>{item.category}</td>
                  <td className="font-mono">{item.size || "-"}</td>
                  <td>{item.packages > 0 ? `${fmt(item.packages)} ${item.packaging}` : "-"}</td>
                  <td className="text-right font-mono">{item.loose_units > 0 ? `${fmt(item.loose_units)} ${item.unit}` : "-"}</td>
                  <td className="text-right font-mono font-bold">
                    {fmt(item.total)} {item.unit}
                    {item.low_stock && <span className="ml-2 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 font-sans text-[11px] font-semibold text-amber-800">Low stock</span>}
                  </td>
                  <td className="text-slate-500">{item.daily_remaining_date || "-"}</td>
                  {canEdit && <td className="text-right whitespace-nowrap">
                    <Btn variant="outline" onClick={() => openDailyUpdate(item)} aria-label={`Update remaining quantity for ${item.name}`} data-testid={`daily-update-${item.id}`}>Update</Btn>
                    <Btn variant="outline" onClick={() => openEdit(item)} aria-label="Edit product"><Pencil size={14} /></Btn>
                    {canDelete && <Btn variant="outline" className="ml-1" onClick={() => remove(item)} aria-label="Delete product"><Trash2 size={14} /></Btn>}
                  </td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!dailyUpdate} onClose={() => setDailyUpdate(null)} title="Daily stock update">
        {dailyUpdate && <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {dailyUpdate.item.name} · Unit: <span className="font-semibold">{dailyUpdate.item.unit}</span>
          </p>
          <Input label="Date" type="date" value={dailyUpdate.date} max={today()} onChange={(event) => setDailyUpdate({ ...dailyUpdate, date: event.target.value })} data-testid="inventory-daily-date" />
          <Input label={`Remaining quantity (${dailyUpdate.item.unit})`} type="number" min="0" step="any" value={dailyUpdate.quantity} onChange={(event) => setDailyUpdate({ ...dailyUpdate, quantity: event.target.value })} data-testid="inventory-daily-quantity" />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setDailyUpdate(null)}>Cancel</Btn>
            <Btn disabled={savingDailyUpdate} onClick={saveDailyUpdate} data-testid="inventory-daily-save">{savingDailyUpdate ? "Saving..." : "Save daily update"}</Btn>
          </div>
        </div>}
      </Modal>

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
