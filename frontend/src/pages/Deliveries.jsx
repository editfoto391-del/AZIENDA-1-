import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Card, Btn, Input, Select, Textarea, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Truck, Plus, Send, Lightbulb, Car, Trash2 } from "lucide-react";
import BarcodeScanner from "@/components/BarcodeScanner";

const STATUSES = ["Planned", "Assigned", "Ready", "Dispatched", "Partially Delivered", "Delivered", "Failed", "Cancelled"];
const META = {
  Planned: "bg-slate-100 text-slate-600 border-slate-200", Assigned: "bg-blue-50 text-blue-700 border-blue-200",
  Ready: "bg-indigo-50 text-indigo-700 border-indigo-200", Dispatched: "bg-amber-50 text-amber-700 border-amber-200",
  "Partially Delivered": "bg-amber-50 text-amber-700 border-amber-200", Delivered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Failed: "bg-red-50 text-red-700 border-red-200", Cancelled: "bg-slate-100 text-slate-400 border-slate-200",
};
const blank = () => ({ customer_id: "", destination: "", size: "small", products: "", driver_id: "", vehicle_id: "", planned_departure: "", status: "Planned", notes: "", cash_collected: 0, items: [] });

export default function Deliveries() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [stock, setStock] = useState([]);
  const [modal, setModal] = useState(null);
  const [recs, setRecs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [vModal, setVModal] = useState(null);
  const [tab, setTab] = useState("deliveries");
  const [sp, setSp] = useSearchParams();

  const load = () => {
    api.get("/deliveries").then(setList).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false));
    api.get("/customers").then(setCustomers);
    api.get("/drivers").then(setDrivers);
    api.get("/vehicles").then(setVehicles).finally(() => setVehiclesLoading(false));
    api.get("/stock").then(setStock);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (sp.get("add")) { setModal(blank()); setSp({}); } }, [sp]);

  const openModal = (d) => { setModal(d ? { ...d } : blank()); setRecs([]); };
  const getRecs = async (size) => { const r = await api.get("/deliveries/recommend", { size }); setRecs(r); };

  const save = async () => {
    if (saving) return;
    if (!modal.destination.trim()) return toast.error("Destination required");
    setSaving(true);
    try {
      const payload = { ...modal, cash_collected: Number(modal.cash_collected) || 0 };
      if (modal.id) await api.put(`/deliveries/${modal.id}`, payload);
      else await api.post("/deliveries", payload);
      toast.success("Delivery saved"); setModal(null); load();
    } catch (e) { toast.error(apiError(e)); }
    finally { setSaving(false); }
  };

  const dispatch = async (d) => {
    if (!window.confirm("Dispatch this delivery? This will deduct stock for the listed items (once).")) return;
    try { await api.post(`/deliveries/${d.id}/dispatch`); toast.success("Dispatched & stock deducted"); load(); }
    catch (e) { toast.error(apiError(e)); }
  };

  const remove = async (d) => {
    if (d.dispatched) return toast.error("A dispatched delivery cannot be cancelled because stock was deducted");
    if (!window.confirm(`Cancel delivery ${d.reference}? The delivery record will be retained.`)) return;
    try { await api.del(`/deliveries/${d.id}`); toast.success("Delivery cancelled"); load(); }
    catch (e) { toast.error(apiError(e)); }
  };

  const saveVehicle = async () => {
    if (!vModal.name.trim()) return toast.error("Vehicle name required");
    try {
      if (vModal.id) await api.put(`/vehicles/${vModal.id}`, vModal);
      else await api.post("/vehicles", vModal);
      toast.success("Vehicle saved"); setVModal(null); load();
    } catch (e) { toast.error(apiError(e)); }
  };

  const addItem = () => setModal({ ...modal, items: [...(modal.items || []), { stock_id: "", qty: 1 }] });
  const setItem = (i, patch) => { const items = [...modal.items]; items[i] = { ...items[i], ...patch }; setModal({ ...modal, items }); };
  const scanDeliveryProduct = async (code) => {
    try {
      const product = await api.post("/products/scan", {
        code,
        scan_id: globalThis.crypto?.randomUUID?.(),
      });
      setModal((current) => {
        if (!current) return current;
        const items = [...(current.items || [])];
        const existingIndex = items.findIndex((item) => item.stock_id === product.stock_id);
        if (existingIndex >= 0) items[existingIndex] = { ...items[existingIndex], qty: Number(items[existingIndex].qty || 0) + 1 };
        else items.push({ stock_id: product.stock_id, qty: 1 });
        return { ...current, items };
      });
      toast.success(`${product.product} · ${product.dimensions} added to this delivery`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div>
      <PageHeader title="Deliveries" subtitle="Deliveries, drivers & vehicles">
        <Btn variant="outline" onClick={() => setTab(tab === "deliveries" ? "vehicles" : "deliveries")}><Car size={16} /> {tab === "deliveries" ? "Vehicles" : "Deliveries"}</Btn>
        {tab === "deliveries"
          ? <Btn onClick={() => openModal(null)} data-testid="add-delivery-btn"><Plus size={16} /> New Delivery</Btn>
          : <Btn onClick={() => setVModal({ name: "", registration: "", vtype: "", capacity: "", available: true, notes: "" })} data-testid="add-vehicle-btn"><Plus size={16} /> Add Vehicle</Btn>}
      </PageHeader>

      {tab === "deliveries" ? (
        <Card className="overflow-hidden">
          {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading deliveries...</p> : list.length === 0 ? <Empty icon={Truck} title="No deliveries yet" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                  <th className="px-4 py-3 font-semibold">Ref</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">Destination</th><th className="px-4 font-semibold">Driver</th><th className="px-4 font-semibold">Status</th><th className="px-4 font-semibold text-right">Cash</th><th className="px-4 font-semibold text-right">Actions</th>
                </tr></thead>
                <tbody>{list.map((d) => (
                  <tr key={d.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`delivery-row-${d.id}`}>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-800">{d.reference}</td>
                    <td className="px-4 text-slate-600">{d.customer_name || "-"}</td>
                    <td className="px-4 text-slate-500">{d.destination}</td>
                    <td className="px-4 text-slate-500">{drivers.find((x) => x.id === d.driver_id)?.name || "-"}</td>
                    <td className="px-4"><Badge cls={META[d.status]}>{d.status}</Badge></td>
                    <td className="px-4 text-right font-mono">{fmtMoney(d.cash_collected)}</td>
                    <td className="px-4 text-right whitespace-nowrap">
                      <button onClick={() => openModal(d)} className="text-primary hover:underline text-xs font-semibold mr-3" data-testid={`edit-delivery-${d.id}`}>Edit</button>
                      {!d.dispatched && d.items?.length > 0 && <button onClick={() => dispatch(d)} className="text-emerald-600 hover:underline text-xs font-semibold" data-testid={`dispatch-${d.id}`}>Dispatch</button>}
                      {d.dispatched && <span className="text-xs text-slate-400">Dispatched</span>}
                      {d.status !== "Cancelled" && <button onClick={() => remove(d)} disabled={d.dispatched} title={d.dispatched ? "Cannot cancel: stock was deducted" : "Cancel delivery"} aria-label={`Cancel delivery ${d.reference}`} className="ml-3 text-slate-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40" data-testid={`delete-delivery-${d.id}`}><Trash2 size={15} /></button>}
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {vehiclesLoading ? <p className="p-6 text-sm text-slate-400" role="status">Loading vehicles...</p> : vehicles.length === 0 ? <Empty icon={Car} title="No vehicles registered" /> : (
            <div className="divide-y divide-border">{vehicles.map((v) => (
              <div key={v.id} className="flex items-center justify-between p-4">
                <div><p className="font-semibold text-slate-800">{v.name} <span className="font-mono text-xs text-slate-400">{v.registration}</span></p><p className="text-xs text-slate-400">{v.vtype} · {v.capacity}</p></div>
                <div className="flex items-center gap-3"><Badge cls={v.available ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}>{v.available ? "Available" : "Unavailable"}</Badge>
                  <button onClick={() => setVModal({ ...v })} className="text-primary hover:underline text-xs font-semibold">Edit</button></div>
              </div>))}</div>
          )}
        </Card>
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? "Edit Delivery" : "New Delivery"} wide>
        {modal && <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label="Customer" value={modal.customer_id} onChange={(e) => setModal({ ...modal, customer_id: e.target.value })}>
              <option value="">Select...</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Destination *" value={modal.destination} onChange={(e) => setModal({ ...modal, destination: e.target.value })} data-testid="delivery-destination-input" />
            <Select label="Delivery Size" value={modal.size} onChange={(e) => { setModal({ ...modal, size: e.target.value }); getRecs(e.target.value); }}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </Select>
            <Select label="Driver" value={modal.driver_id} onChange={(e) => setModal({ ...modal, driver_id: e.target.value })} data-testid="delivery-driver-select">
              <option value="">Unassigned</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Select label="Vehicle" value={modal.vehicle_id} onChange={(e) => setModal({ ...modal, vehicle_id: e.target.value })}>
              <option value="">None</option>{vehicles.filter((v) => v.available || v.id === modal.vehicle_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
            <Select label="Status" value={modal.status} onChange={(e) => setModal({ ...modal, status: e.target.value })}>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </Select>
            <Input label="Planned Departure" type="datetime-local" value={modal.planned_departure || ""} onChange={(e) => setModal({ ...modal, planned_departure: e.target.value })} />
            <Input label="Cash Collected (R)" type="number" value={modal.cash_collected} onChange={(e) => setModal({ ...modal, cash_collected: e.target.value })} />
          </div>

          <Btn variant="outline" onClick={() => getRecs(modal.size)}><Lightbulb size={15} /> Recommend Driver</Btn>
          {recs.length > 0 && <div className="space-y-1.5">{recs.map((r) => (
            <button key={r.driver_id} onClick={() => setModal({ ...modal, driver_id: r.driver_id })} className="w-full text-left rounded-lg bg-accent/40 border border-border px-3 py-2 hover:border-primary">
              <div className="flex justify-between"><span className="font-semibold text-sm text-slate-700">{r.name}</span><Badge cls="bg-blue-50 text-blue-700 border-blue-200">Score {r.score}</Badge></div>
              <p className="text-xs text-slate-500">{r.reason}</p>
            </button>))}</div>}

          <div>
            <div className="flex items-center justify-between mb-2"><span className="text-xs font-semibold text-slate-500">Dispatch Items (deduct stock)</span><button onClick={addItem} className="text-primary text-xs font-semibold">+ Add item</button></div>
            {!modal.dispatched && <div className="mb-3"><BarcodeScanner onScan={scanDeliveryProduct} disabled={saving} dedupeWindowMs={0} label="Scan product to add it to this delivery" /></div>}
            {(modal.items || []).map((it, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <select value={it.stock_id} onChange={(e) => setItem(i, { stock_id: e.target.value })} className="flex-1 rounded border border-input px-2 py-1.5 text-sm">
                  <option value="">Select stock...</option>{stock.map((s) => <option key={s.id} value={s.id}>{s.product} {s.size} (have {s.current})</option>)}
                </select>
                <input type="number" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} className="w-20 rounded border border-input px-2 py-1.5 text-sm" />
                <button onClick={() => setModal({ ...modal, items: modal.items.filter((_, x) => x !== i) })} className="text-red-400 text-sm">✕</button>
              </div>))}
            {modal.dispatched && <p className="text-xs text-amber-600">Stock already deducted for this delivery.</p>}
          </div>

          <Textarea label="Notes" rows={2} value={modal.notes} onChange={(e) => setModal({ ...modal, notes: e.target.value })} />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setModal(null)}>Cancel</Btn><Btn onClick={save} disabled={saving} data-testid="save-delivery-btn">{saving ? "Saving..." : "Save Delivery"}</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!vModal} onClose={() => setVModal(null)} title={vModal?.id ? "Edit Vehicle" : "Add Vehicle"}>
        {vModal && <div className="space-y-4">
          <Input label="Vehicle Name *" value={vModal.name} onChange={(e) => setVModal({ ...vModal, name: e.target.value })} data-testid="vehicle-name-input" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Registration" value={vModal.registration} onChange={(e) => setVModal({ ...vModal, registration: e.target.value })} />
            <Input label="Type" value={vModal.vtype} onChange={(e) => setVModal({ ...vModal, vtype: e.target.value })} />
          </div>
          <Input label="Capacity" value={vModal.capacity} onChange={(e) => setVModal({ ...vModal, capacity: e.target.value })} />
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600"><input type="checkbox" checked={vModal.available} onChange={(e) => setVModal({ ...vModal, available: e.target.checked })} /> Available</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setVModal(null)}>Cancel</Btn><Btn onClick={saveVehicle} data-testid="save-vehicle-btn">Save</Btn></div>
        </div>}
      </Modal>
    </div>
  );
}
