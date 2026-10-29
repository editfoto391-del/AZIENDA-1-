import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { Building2, Eye, Pencil, Plus, Search, ShoppingCart, Trash2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtMoney } from "@/lib/format";
import { Badge, Btn, Card, Empty, Input, Modal, PageHeader, Textarea } from "@/components/common";

const blankSupplier = () => ({
  name: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  terms: "",
  active: true,
  notes: "",
});

export default function Suppliers() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState(null);
  const [buyings, setBuyings] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [modal, setModal] = useState(null);
  const [profile, setProfile] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/suppliers")
    .then(setSuppliers)
    .catch((error) => {
      toast.error(apiError(error));
      setSuppliers([]);
    });

  useEffect(() => {
    load();
    api.get("/buyings")
      .then(setBuyings)
      .catch((error) => {
        toast.error(apiError(error));
        setBuyings([]);
      });
  }, []);

  const filtered = useMemo(() => (suppliers || []).filter((supplier) =>
    `${supplier.name} ${supplier.phone || ""} ${supplier.email || ""} ${supplier.terms || ""} ${supplier.notes || ""}`
      .toLowerCase().includes(query.trim().toLowerCase())
      && (filter === "all" || (filter === "active" ? supplier.active !== false : supplier.active === false)),
  ), [suppliers, query, filter]);

  const save = async () => {
    if (!modal.name.trim()) return toast.error("Name is required");
    if (saving) return;
    setSaving(true);
    try {
      if (modal.id) await api.put(`/suppliers/${modal.id}`, modal);
      else await api.post("/suppliers", modal);
      toast.success("Supplier saved");
      setModal(null);
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const deactivateSupplier = async (supplier) => {
    if (!window.confirm(`Deactivate supplier "${supplier.name}"?`)) return;
    try {
      await api.del(`/suppliers/${supplier.id}`);
      toast.success("Supplier deactivated");
      setSuppliers((current) => current.map((item) => item.id === supplier.id ? { ...item, active: false } : item));
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div>
      <PageHeader title="Suppliers" subtitle={suppliers === null ? "Loading suppliers..." : `${suppliers.length} suppliers`}>
        <Link to="/buyings" className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-secondary" data-testid="suppliers-buyings-link"><ShoppingCart size={16} /> View Buyings</Link>
        <Btn onClick={() => setModal(blankSupplier())} data-testid="add-supplier-btn"><Plus size={16} /> Add Supplier</Btn>
      </PageHeader>

      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search suppliers..."
            aria-label="Search suppliers"
            data-testid="suppliers-search"
            className="w-full rounded-lg border border-input py-2.5 pl-9 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter suppliers"
          className="rounded-lg border border-input px-3 py-2.5 text-sm outline-none"
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </Card>

      <Card className="overflow-hidden">
        {suppliers === null ? <p className="p-6 text-sm text-slate-400" role="status">Loading suppliers...</p> : filtered.length === 0 ? (
          <Empty icon={Building2} title="No suppliers found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Phone</th>
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Terms</th>
                  <th className="px-4 py-3 text-center font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((supplier) => (
                  <tr key={supplier.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`supplier-row-${supplier.id}`}>
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {supplier.name}
                      {supplier.city && <p className="text-xs font-normal text-slate-400">{supplier.city}</p>}
                    </td>
                    <td className="px-4 text-slate-500">{supplier.phone || "-"}</td>
                    <td className="px-4 text-slate-500">{supplier.email || "-"}</td>
                    <td className="max-w-64 px-4 py-3 text-slate-500"><span className="line-clamp-2">{supplier.terms || "-"}</span></td>
                    <td className="px-4 text-center">
                      <Badge cls={supplier.active !== false ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}>
                        {supplier.active !== false ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setProfile(supplier)}
                        aria-label={`View all information for ${supplier.name}`}
                        title="View all information"
                        data-testid={`view-supplier-${supplier.id}`}
                        className="rounded p-1.5 text-slate-400 hover:text-primary"
                      ><Eye size={15} /></button>
                      <button
                        type="button"
                        onClick={() => setModal({ ...supplier, active: supplier.active !== false })}
                        aria-label={`Edit ${supplier.name}`}
                        data-testid={`edit-supplier-${supplier.id}`}
                        className="rounded p-1.5 text-slate-400 hover:text-primary"
                      ><Pencil size={15} /></button>
                      {supplier.active !== false && <button
                        type="button"
                        onClick={() => deactivateSupplier(supplier)}
                        aria-label={`Deactivate ${supplier.name}`}
                        data-testid={`deactivate-supplier-${supplier.id}`}
                        className="rounded p-1.5 text-slate-400 hover:text-red-600"
                      ><Trash2 size={15} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!modal} onClose={() => !saving && setModal(null)} title={modal?.id ? "Edit Supplier" : "Add Supplier"}>
        {modal && (
          <div className="space-y-4">
            <Input label="Name *" value={modal.name} onChange={(event) => setModal({ ...modal, name: event.target.value })} data-testid="supplier-name-input" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Phone" value={modal.phone || ""} onChange={(event) => setModal({ ...modal, phone: event.target.value })} />
              <Input label="Email" value={modal.email || ""} onChange={(event) => setModal({ ...modal, email: event.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Address" value={modal.address || ""} onChange={(event) => setModal({ ...modal, address: event.target.value })} data-testid="supplier-address-input" />
              <Input label="City" value={modal.city || ""} onChange={(event) => setModal({ ...modal, city: event.target.value })} data-testid="supplier-city-input" />
            </div>
            <Textarea label="Terms" rows={3} value={modal.terms || ""} onChange={(event) => setModal({ ...modal, terms: event.target.value })} data-testid="supplier-terms-input" />
            <Textarea label="Notes" rows={2} value={modal.notes || ""} onChange={(event) => setModal({ ...modal, notes: event.target.value })} data-testid="supplier-notes-input" />
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
              <input type="checkbox" checked={modal.active} onChange={(event) => setModal({ ...modal, active: event.target.checked })} /> Active
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="outline" onClick={() => setModal(null)} disabled={saving}>Cancel</Btn>
              <Btn onClick={save} disabled={saving} data-testid="save-supplier-btn">{saving ? "Saving..." : "Save Supplier"}</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!profile} onClose={() => setProfile(null)} title={profile?.name} wide>
        {profile && (
          <div className="space-y-5" data-testid={`supplier-profile-${profile.id}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Name", profile.name],
                ["Phone", profile.phone],
                ["Email", profile.email],
                ["Contact", profile.contact],
                ["Address", profile.address],
                ["City", profile.city],
                ["Terms", profile.terms],
                ["Notes", profile.notes],
                ["Status", profile.active === false ? "Inactive" : "Active"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 p-3">
                  <p className="text-xs text-slate-400">{label}</p>
                  <p className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-800">{value || "-"}</p>
                </div>
              ))}
            </div>
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-800">Purchase history</h3>
                  <p className="text-xs text-slate-400">Buyings linked to this supplier</p>
                </div>
                <Btn variant="outline" onClick={() => navigate("/buyings")}><ShoppingCart size={15} /> View Buyings</Btn>
              </div>
              {buyings === null ? <p className="py-3 text-sm text-slate-400">Loading purchase history...</p> : (() => {
                const supplierBuyings = buyings.filter((buying) =>
                  buying.supplier_id === profile.id
                  || (!buying.supplier_id && buying.source?.trim().toLowerCase() === profile.name.trim().toLowerCase())
                );
                return supplierBuyings.length === 0
                  ? <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-400">No buyings linked to this supplier yet.</p>
                  : <div className="max-h-64 space-y-2 overflow-y-auto">
                    {supplierBuyings.map((buying) => (
                      <div key={buying.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid={`supplier-buying-${buying.id}`}>
                        <div>
                          <p className="font-semibold text-slate-800">{[buying.product, buying.size].filter(Boolean).join(" ")}</p>
                          <p className="text-xs text-slate-400">{fmtDate(buying.date)} · {buying.quantity} × {fmtMoney(buying.unit_price)}</p>
                        </div>
                        <span className="font-mono font-semibold text-slate-700">{fmtMoney(buying.amount)}</span>
                      </div>
                    ))}
                  </div>;
              })()}
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
