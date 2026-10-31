import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { Card, Btn, Input, Select, Textarea, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Truck, Plus, Wrench, Package, Trash2, Pencil, ArrowRight, Fuel, Settings2, RotateCcw } from "lucide-react";

const VTYPES = ["Medium Truck", "Large Truck", "Small Truck", "Bakkie", "Trailer", "Other"];
const RSTATUS = ["Needed", "Scheduled", "In Progress", "Done", "Cancelled"];
const isDone = (r) => r.status === "Done" || r.status === "done";
const isBillable = (r) => isDone(r) && Number(r.amount) > 0;
const isPending = (r) => ["Needed", "Scheduled", "In Progress", "needed"].includes(r.status);
const RTYPES = { expense: { label: "Expense", icon: Fuel, cls: "bg-orange-50 text-orange-700 border-orange-200" }, repair: { label: "Repair", icon: Wrench, cls: "bg-red-50 text-red-700 border-red-200" }, maintenance: { label: "Maintenance", icon: Settings2, cls: "bg-blue-50 text-blue-700 border-blue-200" } };
const PSTAT = { to_buy: { label: "To Buy", cls: "bg-amber-50 text-amber-700 border-amber-200", next: "bought" }, bought: { label: "Bought", cls: "bg-blue-50 text-blue-700 border-blue-200", next: "installed" }, installed: { label: "Installed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" } };
const blankV = () => ({ name: "", registration: "", vtype: "Medium Truck", capacity: "", length: "", available: true, notes: "" });
const blankR = () => ({ type: "expense", description: "", amount: "", date: today(), status: "Done" });
const blankP = () => ({ name: "", quantity: 1, expected_price: "", actual_cost: "", vehicle_id: "", status: "to_buy", notes: "" });

function VehicleCard({ v, recs, onOpen, onEdit, onDelete }) {
  const sum = (t) => recs.filter((r) => r.type === t && isDone(r)).reduce((s, r) => s + (r.amount || 0), 0);
  const needed = recs.filter(isPending).length;
  return (
    <Card className="p-5 hover:shadow-md transition-shadow" data-testid={`vehicle-card-${v.id}`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="font-bold text-slate-900 font-display text-lg">{v.name}</p>
          <p className="text-xs text-slate-400">{[v.vtype, v.length, v.registration].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <Badge cls={v.available ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}>{v.available ? "Available" : "Unavailable"}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center mb-4">
        {Object.entries(RTYPES).map(([k, m]) => (
          <div key={k} className="rounded-lg bg-slate-50 py-2">
            <p className="text-[10px] font-semibold uppercase text-slate-400">{m.label}</p>
            <p className="text-sm font-mono font-bold text-slate-700">{fmtMoney(sum(k))}</p>
          </div>))}
      </div>
      <p className="text-[11px] text-slate-400 mb-2">Capacity: {v.capacity || "requires confirmation"}</p>
      {needed > 0 && <p className="text-xs font-semibold text-red-600 mb-3" data-testid={`vehicle-attention-${v.id}`}>{needed} repair/maintenance needing attention</p>}
      <div className="flex gap-2">
        <Btn variant="subtle" className="flex-1" onClick={onOpen} data-testid={`vehicle-records-${v.id}`}>Records <ArrowRight size={14} /></Btn>
        <Btn variant="outline" onClick={onEdit} data-testid={`edit-vehicle-${v.id}`}><Pencil size={14} /></Btn>
        <Btn variant="outline" onClick={onDelete} aria-label={`Remove ${v.name}`} data-testid={`delete-vehicle-${v.id}`}><Trash2 size={14} /></Btn>
      </div>
    </Card>
  );
}

export default function Fleet() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState([]);
  const [parts, setParts] = useState([]);
  const [tab, setTab] = useState("vehicles");
  const [vModal, setVModal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [rForm, setRForm] = useState(blankR());
  const [pModal, setPModal] = useState(null);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [authorizing, setAuthorizing] = useState(false);

  const load = () => {
    Promise.all([api.get("/vehicles"), api.get("/vehicles/records/all"), api.get("/spareparts")])
      .then(([vehicleData, recordData, partData]) => { setVehicles(vehicleData); setRecords(recordData); setParts(partData); })
      .catch((e) => toast.error(apiError(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const err = (e) => toast.error(apiError(e));
  const saveVehicle = async () => {
    if (!vModal.name.trim()) return toast.error("Vehicle name required");
    try { vModal.id ? await api.put(`/vehicles/${vModal.id}`, vModal) : await api.post("/vehicles", vModal); toast.success("Vehicle saved"); setVModal(null); load(); } catch (e) { err(e); }
  };
  const delVehicle = async (v) => {
    if (!window.confirm(`Remove "${v.name}" from the fleet? Its records and history will be retained.`)) return;
    try { await api.del(`/vehicles/${v.id}`); toast.success("Vehicle removed from the fleet"); load(); }
    catch (e) { err(e); }
  };
  const requestApproval = (details) => {
    if (user?.can_skip_supervisor_approval) {
      details.execute(undefined).catch(err);
      return;
    }
    setApprovalRequest(details);
  };
  const submitApproval = async (event) => {
    event.preventDefault();
    if (!approvalRequest || !supervisorPassword || authorizing) return;
    setAuthorizing(true);
    try {
      const approval = await api.post("/fleet-expense-authorizations", {
        password: supervisorPassword,
        resource_type: approvalRequest.resourceType,
        action: approvalRequest.action,
        resource_id: approvalRequest.resourceId,
        target_id: approvalRequest.targetId,
      });
      await approvalRequest.execute(approval.authorization_id);
      setApprovalRequest(null);
      setSupervisorPassword("");
    } catch (e) { err(e); }
    finally { setAuthorizing(false); }
  };
  const addRecord = async () => {
    if (!rForm.description.trim()) return toast.error("Description required");
    const payload = { ...rForm, amount: Number(rForm.amount) || 0 };
    const execute = async (supervisor_authorization) => {
      await api.post(`/vehicles/${detail.id}/records`, { ...payload, supervisor_authorization });
      toast.success("Record added"); setRForm(blankR()); load();
    };
    if (isDone(payload) && payload.amount > 0) {
      requestApproval({ resourceType: "vehicle_record", action: "create", targetId: detail.id, execute });
      return;
    }
    try { await execute(undefined); } catch (e) { err(e); }
  };
  const delRecord = async (r) => {
    if (!window.confirm("Cancel this vehicle record? Its history will be retained.")) return;
    const reason = window.prompt("Reason for cancelling this vehicle record:");
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    const execute = async (supervisor_authorization) => {
      await api.post(`/vehicles/records/${r.id}/cancel`, { reason: reason.trim(), supervisor_authorization });
      load();
    };
    if (isBillable(r)) {
      requestApproval({ resourceType: "vehicle_record", action: "cancel", resourceId: r.id, execute });
      return;
    }
    try { await execute(undefined); } catch (e) { err(e); }
  };
  const setRecStatus = async (r, status) => {
    const payload = { ...r, status };
    const execute = async (supervisor_authorization) => {
      await api.put(`/vehicles/records/${r.id}`, { ...payload, supervisor_authorization });
      load();
    };
    if ((isBillable(r) || isBillable(payload))) {
      requestApproval({ resourceType: "vehicle_record", action: "edit", resourceId: r.id, execute });
      return;
    }
    try { await execute(undefined); } catch (e) { err(e); }
  };
  const savePart = async () => {
    if (!pModal.name.trim()) return toast.error("Part name required");
    const payload = { ...pModal, quantity: Number(pModal.quantity) || 1, expected_price: Number(pModal.expected_price) || 0, actual_cost: pModal.actual_cost === "" || pModal.actual_cost == null ? null : Number(pModal.actual_cost) };
    if (payload.status !== "to_buy" && !(payload.actual_cost > 0)) return toast.error("Enter the actual purchase cost when the part is bought");
    const execute = async (supervisor_authorization) => {
      const data = { ...payload, supervisor_authorization };
      if (pModal.id) await api.put(`/spareparts/${pModal.id}`, data);
      else await api.post("/spareparts", data);
      toast.success("Spare part saved"); setPModal(null); load();
    };
    if (payload.status !== "to_buy") {
      requestApproval({ resourceType: "spare_part", action: pModal.id ? "edit" : "create", resourceId: pModal.id, execute });
      return;
    }
    try { await execute(undefined); } catch (e) { err(e); }
  };
  const advancePart = async (p) => {
    const next = PSTAT[p.status].next;
    let actual_cost = p.actual_cost;
    if (next === "bought") {
      const v = window.prompt(`Actual total purchase cost for "${p.name}" (R):`, String((p.expected_price || 0) * (p.quantity || 1) || ""));
      if (v === null) return;
      actual_cost = Number(v);
      if (!(actual_cost > 0)) return toast.error("Enter a valid cost");
    }
    const execute = async (supervisor_authorization) => {
      await api.put(`/spareparts/${p.id}`, { ...p, status: next, actual_cost, supervisor_authorization });
      toast.success(`Marked ${PSTAT[next].label}`); load();
    };
    requestApproval({ resourceType: "spare_part", action: "edit", resourceId: p.id, execute });
  };
  const delPart = async (p) => { if (!window.confirm(`Archive "${p.name}"? Its record will be retained.`)) return; try { await api.del(`/spareparts/${p.id}`); load(); } catch (e) { err(e); } };
  const restorePart = async (p) => { try { await api.post(`/spareparts/${p.id}/restore`); toast.success("Spare part restored"); load(); } catch (e) { err(e); } };

  const vRecs = (id) => records.filter((r) => r.vehicle_id === id);
  const partsTotal = (s) => parts.filter((p) => p.status === s && !p.archived).reduce((t, p) => t + (s === "to_buy" ? (p.expected_price || 0) * (p.quantity || 1) : (p.actual_cost || 0)), 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Fleet" subtitle="Vehicles, expenses, repairs, maintenance & spare parts">
        {tab === "vehicles"
          ? <Btn onClick={() => setVModal(blankV())} data-testid="add-vehicle-btn"><Plus size={16} /> Add Vehicle</Btn>
          : <Btn onClick={() => setPModal(blankP())} data-testid="add-part-btn"><Plus size={16} /> Add Spare Part</Btn>}
      </PageHeader>

      <div className="inline-flex rounded-lg bg-slate-100 p-1">
        {[["vehicles", "Vehicles", Truck], ["parts", "Spare Parts", Package]].map(([k, l, I]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`fleet-tab-${k}`}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}><I size={15} /> {l}</button>
        ))}
      </div>

      {tab === "vehicles" ? (
        loading ? <Card><p className="p-6 text-sm text-slate-400" role="status">Loading vehicles...</p></Card> : vehicles.length === 0 ? <Card><Empty icon={Truck} title="No vehicles registered" /></Card> : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {vehicles.map((v) => <VehicleCard key={v.id} v={v} recs={vRecs(v.id)} onOpen={() => { setDetail(v); setRForm(blankR()); }} onEdit={() => setVModal({ ...v })} onDelete={() => delVehicle(v)} />)}
          </div>)
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Object.entries(PSTAT).map(([k, m]) => (
              <Card key={k} className="p-5" data-testid={`parts-summary-${k}`}>
                <p className="text-xs font-semibold uppercase text-slate-500">{m.label}</p>
                <p className="text-2xl font-bold font-mono text-slate-900 mt-1">{loading ? "..." : parts.filter((p) => p.status === k).length}</p>
                <p className="text-xs text-slate-400 mt-1 font-mono">{loading ? "..." : fmtMoney(partsTotal(k))}</p>
              </Card>))}
          </div>
          <Card className="overflow-hidden">
            {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading spare parts...</p> : parts.length === 0 ? <Empty icon={Package} title="No spare parts yet" hint="Add parts you need to buy." /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[760px]">
                  <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                    <th className="px-4 py-3 font-semibold">Part</th><th className="px-4 font-semibold">Vehicle</th><th className="px-4 font-semibold text-right">Qty</th><th className="px-4 font-semibold text-right">Est. Unit</th><th className="px-4 font-semibold text-right">Actual Cost</th><th className="px-4 font-semibold">Status</th><th className="px-4 font-semibold text-right">Actions</th>
                  </tr></thead>
                  <tbody>{parts.map((p) => (
                    <tr key={p.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`part-row-${p.id}`}>
                      <td className="px-4 py-3"><p className="font-semibold text-slate-800">{p.name}</p>{p.notes && <p className="text-xs text-slate-400">{p.notes}</p>}</td>
                      <td className="px-4 text-slate-500">{p.vehicle_name || "-"}</td>
                      <td className="px-4 text-right font-mono">{p.quantity}</td>
                      <td className="px-4 text-right font-mono">{fmtMoney(p.expected_price)}</td>
                      <td className="px-4 text-right font-mono" data-testid={`part-actual-${p.id}`}>{p.actual_cost ? fmtMoney(p.actual_cost) : "-"}</td>
                      <td className="px-4"><Badge cls={PSTAT[p.status]?.cls}>{PSTAT[p.status]?.label}</Badge>{p.archived && <Badge cls="ml-2 bg-amber-50 text-amber-700 border-amber-200">Archived</Badge>}</td>
                      <td className="px-4 text-right whitespace-nowrap">
                        {p.archived ? <button onClick={() => restorePart(p)} className="text-emerald-700" aria-label={`Restore ${p.name}`} data-testid={`restore-part-${p.id}`}><RotateCcw size={15} /></button> : <>
                          {PSTAT[p.status]?.next && <button onClick={() => advancePart(p)} className="inline-flex items-center gap-1 text-emerald-600 hover:underline text-xs font-semibold mr-3" data-testid={`advance-part-${p.id}`}>Mark {PSTAT[PSTAT[p.status].next].label} <ArrowRight size={12} /></button>}
                          <button onClick={() => setPModal({ ...p })} className="text-slate-400 hover:text-primary mr-3" data-testid={`edit-part-${p.id}`}><Pencil size={15} /></button>
                          {p.status === "to_buy" && <button onClick={() => delPart(p)} className="text-slate-400 hover:text-red-600" data-testid={`delete-part-${p.id}`}><Trash2 size={15} /></button>}
                        </>}
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>)}
          </Card>
        </>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`${detail?.name || ""} — Records`} wide>
        {detail && <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <Select label="Type" value={rForm.type} onChange={(e) => setRForm({ ...rForm, type: e.target.value })} data-testid="record-type-select">
              {Object.entries(RTYPES).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </Select>
            <Input label="Amount (R)" type="number" value={rForm.amount} onChange={(e) => setRForm({ ...rForm, amount: e.target.value })} data-testid="record-amount-input" />
            <Input label="Date" type="date" value={rForm.date} onChange={(e) => setRForm({ ...rForm, date: e.target.value })} data-testid="record-date-input" />
            <Select label="Status" value={rForm.status} onChange={(e) => setRForm({ ...rForm, status: e.target.value })} data-testid="record-status-select">
              {RSTATUS.map((s) => <option key={s}>{s}</option>)}
            </Select>
          </div>
          <div className="flex gap-2">
            <div className="flex-1"><Input placeholder="Description (e.g. Diesel, brake pads, oil change)" value={rForm.description} onChange={(e) => setRForm({ ...rForm, description: e.target.value })} data-testid="record-description-input" /></div>
            <Btn onClick={addRecord} data-testid="add-record-btn"><Plus size={16} /> Add</Btn>
          </div>
          {vRecs(detail.id).length === 0 ? <Empty icon={Wrench} title="No records for this vehicle" /> : (
            <div className="divide-y divide-border border border-border rounded-lg">{vRecs(detail.id).map((r) => {
              const m = RTYPES[r.type] || RTYPES.expense;
              return (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3" data-testid={`record-row-${r.id}`}>
                  <m.icon size={16} className="text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-slate-800 truncate">{r.description}</p><p className="text-xs text-slate-400">{fmtDate(r.date)}</p></div>
                  <Badge cls={m.cls}>{m.label}</Badge>
                  <select value={r.status === "done" ? "Done" : r.status === "needed" ? "Needed" : r.status} onChange={(e) => setRecStatus(r, e.target.value)} className="rounded border border-input px-1.5 py-1 text-xs" data-testid={`record-status-${r.id}`}>
                    {RSTATUS.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <span className="font-mono text-sm text-slate-700 w-28 text-right">{fmtMoney(r.amount)}</span>
                  <button onClick={() => delRecord(r)} className="text-slate-300 hover:text-red-600" data-testid={`delete-record-${r.id}`}><Trash2 size={15} /></button>
                </div>);
            })}</div>)}
        </div>}
      </Modal>

      <Modal open={!!vModal} onClose={() => setVModal(null)} title={vModal?.id ? "Edit Vehicle" : "Add Vehicle"}>
        {vModal && <div className="space-y-4">
          <Input label="Vehicle Name *" value={vModal.name} onChange={(e) => setVModal({ ...vModal, name: e.target.value })} data-testid="vehicle-name-input" />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Type" value={vModal.vtype} onChange={(e) => setVModal({ ...vModal, vtype: e.target.value })} data-testid="vehicle-type-select">
              {[...new Set([...VTYPES, vModal.vtype].filter(Boolean))].map((t) => <option key={t}>{t}</option>)}
            </Select>
            <Input label="Registration" value={vModal.registration} onChange={(e) => setVModal({ ...vModal, registration: e.target.value })} data-testid="vehicle-reg-input" />
            <Input label="Capacity" value={vModal.capacity} onChange={(e) => setVModal({ ...vModal, capacity: e.target.value })} data-testid="vehicle-capacity-input" />
            <Input label="Length" placeholder="e.g. 9 m" value={vModal.length || ""} onChange={(e) => setVModal({ ...vModal, length: e.target.value })} data-testid="vehicle-length-input" />
          </div>
          <Textarea label="Notes" rows={2} value={vModal.notes} onChange={(e) => setVModal({ ...vModal, notes: e.target.value })} />
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600"><input type="checkbox" checked={vModal.available} onChange={(e) => setVModal({ ...vModal, available: e.target.checked })} data-testid="vehicle-available-checkbox" /> Available</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setVModal(null)}>Cancel</Btn><Btn onClick={saveVehicle} data-testid="save-vehicle-btn">Save</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!pModal} onClose={() => setPModal(null)} title={pModal?.id ? "Edit Spare Part" : "Add Spare Part"}>
        {pModal && <div className="space-y-4">
          <Input label="Part Name *" value={pModal.name} onChange={(e) => setPModal({ ...pModal, name: e.target.value })} data-testid="part-name-input" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Quantity" type="number" value={pModal.quantity} onChange={(e) => setPModal({ ...pModal, quantity: e.target.value })} data-testid="part-qty-input" />
            <Input label="Est. Unit Price (R)" type="number" value={pModal.expected_price} onChange={(e) => setPModal({ ...pModal, expected_price: e.target.value })} data-testid="part-price-input" />
            <Input label="Actual Total Cost (R)" type="number" value={pModal.actual_cost ?? ""} onChange={(e) => setPModal({ ...pModal, actual_cost: e.target.value })} data-testid="part-actual-cost-input" />
            <Select label="Vehicle" value={pModal.vehicle_id} onChange={(e) => setPModal({ ...pModal, vehicle_id: e.target.value })} data-testid="part-vehicle-select">
              <option value="">General</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
            <Select label="Status" value={pModal.status} onChange={(e) => setPModal({ ...pModal, status: e.target.value })} data-testid="part-status-select">
              {Object.entries(PSTAT).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </Select>
          </div>
          <p className="text-[11px] text-slate-400">Buying a part creates one Vehicle expense with the actual cost. Installing does not add another expense.</p>
          <Textarea label="Notes" rows={2} value={pModal.notes} onChange={(e) => setPModal({ ...pModal, notes: e.target.value })} />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setPModal(null)}>Cancel</Btn><Btn onClick={savePart} data-testid="save-part-btn">Save</Btn></div>
        </div>}
      </Modal>
      <Modal open={!!approvalRequest} onClose={() => { setApprovalRequest(null); setSupervisorPassword(""); }} title="Supervisor approval required">
        {approvalRequest && <form onSubmit={submitApproval} className="space-y-4" data-testid="fleet-expense-authorization-form">
          <p className="text-sm text-slate-600">Enter the supervisor password to {approvalRequest.resourceType === "vehicle_record" ? approvalRequest.action === "create" ? "record this completed vehicle cost" : approvalRequest.action === "edit" ? "change a completed vehicle cost" : "cancel this vehicle cost" : approvalRequest.action === "create" ? "record this spare-part purchase" : "change this purchased spare part"}. Approval is required for every user role.</p>
          <Input label="Supervisor password" type="password" autoComplete="current-password" autoFocus required value={supervisorPassword} onChange={(event) => setSupervisorPassword(event.target.value)} data-testid="fleet-supervisor-password-input" />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => { setApprovalRequest(null); setSupervisorPassword(""); }}>Cancel</Btn>
            <Btn type="submit" disabled={authorizing} data-testid="authorize-fleet-expense-btn">{authorizing ? "Checking..." : "Approve action"}</Btn>
          </div>
        </form>}
      </Modal>
    </div>
  );
}
