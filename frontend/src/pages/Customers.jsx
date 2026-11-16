import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDate, newKey, STATUS_META, today } from "@/lib/format";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader, Empty, Textarea } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { usesPriceZones } from "@/lib/company";
import { Users, Search, Plus, Pencil, Eye, Trash2 } from "lucide-react";
import { PAYMENT_METHODS, RECEIVING_OPTIONS } from "@/lib/paymentMethods";

const blank = { name: "", client_number: "", phone: "", email: "", address: "", city: "", notes: "", default_zone: 1, payment_terms: "Due on Delivery", active: true };

const mostUsedZone = (invoices, fallback) => {
  const counts = (invoices || []).reduce((result, invoice) => {
    if (!["void", "draft"].includes(invoice.status)) {
      const zone = Number(invoice.zone || fallback || 1);
      result[zone] = (result[zone] || 0) + 1;
    }
    return result;
  }, {});
  const zones = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || Number(a) - Number(b));
  return zones.length ? `Zone ${zones[0]}` : (fallback ? `Zone ${fallback}` : "—");
};

export default function Customers() {
  const { user } = useAuth();
  const priceZonesEnabled = usesPriceZones(user?.company_id);
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(null); // form data or null
  const [profile, setProfile] = useState(null);
  const [advanceForm, setAdvanceForm] = useState(null);
  const [advanceAllocation, setAdvanceAllocation] = useState(null);
  const [advanceSaving, setAdvanceSaving] = useState(false);
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const profileRequest = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get("/customers", {
      page,
      page_size: 50,
      q: debouncedQ,
      active_filter: filter,
    }).then((result) => {
      if (!active) return;
      setList(result.items);
      setTotal(result.total);
      const lastPage = Math.max(1, Math.ceil(result.total / 50));
      if (page > lastPage) setPage(lastPage);
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [page, debouncedQ, filter, user?.company_id, reload]);

  useEffect(() => {
    setList([]);
    setTotal(0);
    setPage(1);
    setProfile(null);
    setModal(null);
    profileRequest.current += 1;
  }, [user?.company_id]);

  const load = () => setReload((current) => current + 1);
  useEffect(() => { if (sp.get("add")) { setModal({ ...blank }); setSp({}); } }, [sp]);

  const save = async () => {
    if (!modal.name.trim()) return toast.error("Name is required");
    try {
      if (modal.id) await api.put(`/customers/${modal.id}`, modal);
      else await api.post("/customers", modal);
      toast.success("Customer saved");
      if (!modal.id) setPage(1);
      setModal(null); load();
    } catch (e) { toast.error(apiError(e)); }
  };

  const removeCustomer = async (customer) => {
    const message = user?.is_admin
      ? `Permanently delete "${customer.name}" from this profile? Invoices and payments will be kept and marked as belonging to a deleted customer.`
      : `Deactivate customer "${customer.name}"? The customer record will be retained and can be reactivated later.`;
    if (!window.confirm(message)) return;
    try {
      await api.del(`/customers/${customer.id}`);
      if (user?.is_admin) {
        toast.success("Customer deleted; invoices and payments retained");
      } else {
        toast.success("Customer deactivated");
      }
      load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const [otherBalance, setOtherBalance] = useState("");
  const saveOtherBalance = async () => {
    try {
      const value = otherBalance === "" ? 0 : Number(otherBalance);
      const updated = await api.put(`/customers/${profile.c.id}`, {
        ...profile.c,
        other_balance: value,
        other_balance_express: true,
      });
      setProfile({ ...profile, c: updated, other_balance: value });
      toast.success("Other balance saved");
      load();
    } catch (e) { toast.error(apiError(e)); }
  };

  const applyBalance = (updated) => {
    setProfile((prev) => ({ ...prev, c: updated, other_balance: updated.other_balance || 0 }));
    setOtherBalance(updated.other_balance ? String(updated.other_balance) : "");
    load();
  };
  const toggleExpressBalance = async () => {
    try {
      const flag = !profile.c.other_balance_express;
      applyBalance(await api.put(`/customers/${profile.c.id}`, { ...profile.c, other_balance_express: flag }));
      toast.success(flag ? "Balance added to Express Balances and Payments" : "Balance removed from Express Balances and Payments");
    } catch (e) { toast.error(apiError(e)); }
  };
  const openProfile = async (c) => {
    const requestId = ++profileRequest.current;
    try {
      const s = await api.get(`/customers/${c.id}/summary`);
      if (profileRequest.current !== requestId) return;
      setOtherBalance(s.other_balance ? String(s.other_balance) : "");
      setProfile({ c, ...s });
    } catch (error) {
      if (profileRequest.current === requestId) toast.error(apiError(error));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / 50));
  const rangeStart = total === 0 ? 0 : (page - 1) * 50 + 1;
  const rangeEnd = Math.min(page * 50, total);
  const availableAdvancePayments = (profile?.advance_payments || []).filter(
    (payment) => !payment.reversed && !payment.archived && Number(payment.available_amount) > 0,
  );
  const unpaidInvoicesForAdvance = (payment) => (profile?.invoices || []).filter(
    (invoice) => (invoice.invoice_type === "express") === Boolean(payment.express)
      && !["draft", "void"].includes(invoice.status)
      && Boolean(invoice.number)
      && Number(invoice.outstanding) > 0,
  );
  const selectedAdvanceInvoice = advanceAllocation
    ? unpaidInvoicesForAdvance(advanceAllocation.payment).find((invoice) => invoice.id === advanceAllocation.invoice_id)
    : null;
  const advanceApplicationLimit = selectedAdvanceInvoice && advanceAllocation
    ? Math.min(Number(advanceAllocation.payment.available_amount), Number(selectedAdvanceInvoice.outstanding))
    : 0;
  const otherBalancePayments = profile?.other_balance_payments?.length
    ? profile.other_balance_payments
    : profile?.c?.other_balance_payments || [];

  const openAdvancePayment = () => setAdvanceForm({
    amount: "",
    method: "Cash",
    receiving_on: "",
    date: today(),
    express: false,
    reference: "",
    notes: "",
    idempotency_key: newKey(),
  });
  const saveAdvancePayment = async () => {
    if (!profile || advanceSaving) return;
    const amount = Number(advanceForm.amount);
    if (!(amount > 0)) return toast.error("Amount must be greater than 0");
    if (advanceForm.method !== "Cash" && !advanceForm.receiving_on) {
      return toast.error("Select where the payment was received");
    }
    setAdvanceSaving(true);
    try {
      await api.post(`/customers/${profile.c.id}/advance-payments`, { ...advanceForm, amount });
      setAdvanceForm(null);
      toast.success("Advance payment recorded");
      await openProfile(profile.c);
      load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setAdvanceSaving(false);
    }
  };
  const openAdvanceAllocation = (payment) => {
    const invoice = unpaidInvoicesForAdvance(payment)[0];
    setAdvanceAllocation({
      payment,
      invoice_id: invoice?.id || "",
      amount: invoice
        ? Math.min(Number(payment.available_amount), Number(invoice.outstanding)).toFixed(2)
        : "",
      idempotency_key: newKey(),
    });
  };
  const applyAdvancePayment = async () => {
    if (!profile || !advanceAllocation || advanceSaving) return;
    const amount = Number(advanceAllocation.amount);
    if (!(amount > 0) || amount > advanceApplicationLimit) {
      return toast.error(`Amount must be between R 0.01 and ${fmtMoney(advanceApplicationLimit)}`);
    }
    setAdvanceSaving(true);
    try {
      await api.post(
        `/customers/${profile.c.id}/advance-payments/${advanceAllocation.payment.id}/apply`,
        {
          invoice_id: advanceAllocation.invoice_id,
          amount,
          idempotency_key: advanceAllocation.idempotency_key,
        },
      );
      setAdvanceAllocation(null);
      toast.success("Advance payment applied to invoice");
      await openProfile(profile.c);
      load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setAdvanceSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Customers" subtitle={loading ? "Loading customers..." : `Showing ${rangeStart}–${rangeEnd} of ${total.toLocaleString()} customers`}>
        <Btn onClick={() => setModal({ ...blank })} data-testid="add-customer-btn"><Plus size={16} /> Add Customer</Btn>
      </PageHeader>

      <Card className="p-4 mb-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input data-testid="customer-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email..."
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary" />
        </div>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} data-testid="customer-filter"
          className="rounded-lg border border-input px-3 py-2.5 text-sm outline-none">
          <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      </Card>

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading customers...</p> : list.length === 0 ? <Empty icon={Users} title="No customers found" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="px-4 py-3 font-semibold">Name</th><th className="px-4 font-semibold">Client Number</th><th className="px-4 font-semibold">Phone</th>{priceZonesEnabled && <th className="px-4 font-semibold">Zone</th>}<th className="px-4 font-semibold">Terms</th><th className="px-4 font-semibold text-center">Status</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{list.map((c) => (
                <tr key={c.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`customer-row-${c.id}`}>
                  <td className="px-4 py-3 font-semibold text-slate-800">{c.name}</td>
                  <td className="px-4 text-slate-500">{c.client_number || "-"}</td>
                  <td className="px-4 text-slate-500">{c.phone || "-"}</td>
                  {priceZonesEnabled && <td className="px-4"><Badge cls="bg-blue-50 text-blue-700 border-blue-200">Zone {c.default_zone}</Badge></td>}
                  <td className="px-4 text-slate-500">{c.payment_terms}</td>
                  <td className="px-4 text-center"><Badge cls={c.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}>{c.active ? "Active" : "Inactive"}</Badge></td>
                  <td className="px-4 text-right whitespace-nowrap">
                    <button onClick={() => openProfile(c)} className="text-slate-400 hover:text-primary p-1.5" data-testid={`view-customer-${c.id}`}><Eye size={16} /></button>
                    <button onClick={() => setModal({ ...c })} className="text-slate-400 hover:text-primary p-1.5" data-testid={`edit-customer-${c.id}`}><Pencil size={16} /></button>
                    {(user?.is_admin || c.active) && <button onClick={() => removeCustomer(c)} className="text-slate-400 hover:text-red-600 p-1.5" aria-label={`${user?.is_admin ? "Permanently delete" : "Deactivate"} ${c.name}`} title={user?.is_admin ? "Permanently delete customer" : "Deactivate customer"} data-testid={`delete-customer-${c.id}`}><Trash2 size={16} /></button>}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="customer-pagination">
        <p className="text-sm text-slate-500">
          Showing {rangeStart}–{rangeEnd} of {total.toLocaleString()} customers
        </p>
        <div className="flex items-center gap-2">
          <Btn variant="outline" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} data-testid="customer-previous-page">Previous</Btn>
          <span className="min-w-24 text-center text-sm text-slate-600">Page {page} of {pageCount}</span>
          <Btn variant="outline" disabled={loading || page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} data-testid="customer-next-page">Next</Btn>
        </div>
      </div>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? "Edit Customer" : "Add Customer"}>
        {modal && (
          <div className="space-y-4">
            <Input label="Name *" value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} data-testid="customer-name-input" />
            <Input label="Client Number" value={modal.client_number || ""} onChange={(e) => setModal({ ...modal, client_number: e.target.value })} data-testid="customer-client-number-input" />
            <div className="grid grid-cols-2 gap-3">
              <Input label={modal.id ? "Phone" : undefined} aria-label="Phone" value={modal.phone} onChange={(e) => setModal({ ...modal, phone: e.target.value })} />
              <Input label="Email" value={modal.email} onChange={(e) => setModal({ ...modal, email: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Address" value={modal.address} onChange={(e) => setModal({ ...modal, address: e.target.value })} data-testid="customer-address-input" />
              <Input label="City" value={modal.city || ""} onChange={(e) => setModal({ ...modal, city: e.target.value })} data-testid="customer-city-input" />
            </div>
            <Input label="Notes" value={modal.notes || ""} onChange={(e) => setModal({ ...modal, notes: e.target.value })} data-testid="customer-notes-input" />
            {priceZonesEnabled && <div className="grid grid-cols-2 gap-3">
              <Select label="Default Price Zone" value={modal.default_zone} onChange={(e) => setModal({ ...modal, default_zone: Number(e.target.value) })}>
                <option value={1}>Zone 1</option><option value={2}>Zone 2</option>
              </Select>
            </div>}
            <div className={`grid ${priceZonesEnabled ? "grid-cols-2" : "grid-cols-1"} gap-3`}>
              <Select label="Payment Terms" value={modal.payment_terms} onChange={(e) => setModal({ ...modal, payment_terms: e.target.value })}>
                {["Due on Delivery", "Cash on Delivery", "7 Days", "14 Days", "30 Days", "Custom Terms"].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
              <input type="checkbox" checked={modal.active} onChange={(e) => setModal({ ...modal, active: e.target.checked })} /> Active
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Btn variant="outline" onClick={() => setModal(null)}>Cancel</Btn>
              <Btn onClick={save} data-testid="save-customer-btn">Save Customer</Btn>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={!!advanceForm} onClose={() => !advanceSaving && setAdvanceForm(null)} title="Record Advance Payment">
        {advanceForm && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">{profile?.c.name} · This payment will be available to apply to the customer's invoices.</p>
            <Input
              label="Amount (R)"
              type="number"
              min="0.01"
              step="0.01"
              value={advanceForm.amount}
              onChange={(event) => setAdvanceForm({ ...advanceForm, amount: event.target.value })}
              data-testid="advance-payment-amount"
            />
            <Select
              label="Invoice type"
              value={advanceForm.express ? "express" : "standard"}
              onChange={(event) => setAdvanceForm({ ...advanceForm, express: event.target.value === "express" })}
              data-testid="advance-payment-invoice-type"
            >
              <option value="standard">Standard</option>
              <option value="express">Express Website</option>
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Payment Method" value={advanceForm.method} onChange={(event) => setAdvanceForm({ ...advanceForm, method: event.target.value })}>
                {PAYMENT_METHODS.map((method) => <option key={method}>{method}</option>)}
              </Select>
              <Input label="Date" type="date" value={advanceForm.date} onChange={(event) => setAdvanceForm({ ...advanceForm, date: event.target.value })} />
            </div>
            <Select label="Receiving on" value={advanceForm.receiving_on} onChange={(event) => setAdvanceForm({ ...advanceForm, receiving_on: event.target.value })}>
              <option value="">Select receiving account</option>
              {RECEIVING_OPTIONS.map((option) => <option key={option}>{option}</option>)}
            </Select>
            <Input label="Reference (optional)" value={advanceForm.reference} onChange={(event) => setAdvanceForm({ ...advanceForm, reference: event.target.value })} />
            <Textarea label="Notes (optional)" rows={2} value={advanceForm.notes} onChange={(event) => setAdvanceForm({ ...advanceForm, notes: event.target.value })} />
            <div className="flex justify-end gap-2">
              <Btn variant="outline" disabled={advanceSaving} onClick={() => setAdvanceForm(null)}>Cancel</Btn>
              <Btn variant="success" disabled={advanceSaving} onClick={saveAdvancePayment} data-testid="confirm-advance-payment">
                {advanceSaving ? "Saving..." : "Record Payment"}
              </Btn>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={!!advanceAllocation} onClose={() => !advanceSaving && setAdvanceAllocation(null)} title="Apply Advance Payment">
        {advanceAllocation && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              Available credit: {fmtMoney(advanceAllocation.payment.available_amount)}
            </p>
            <Select
              label="Invoice"
              value={advanceAllocation.invoice_id}
              onChange={(event) => {
                const invoice = unpaidInvoicesForAdvance(advanceAllocation.payment)
                  .find((item) => item.id === event.target.value);
                setAdvanceAllocation({
                  ...advanceAllocation,
                  invoice_id: event.target.value,
                  amount: invoice
                    ? Math.min(Number(advanceAllocation.payment.available_amount), Number(invoice.outstanding)).toFixed(2)
                    : "",
                });
              }}
              data-testid="advance-invoice-select"
            >
              <option value="">Select invoice</option>
              {unpaidInvoicesForAdvance(advanceAllocation.payment).map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.number || "Invoice"} · Outstanding {fmtMoney(invoice.outstanding)}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500">Outstanding: {fmtMoney(selectedAdvanceInvoice?.outstanding || 0)}</p>
            <Input
              label="Amount to apply (R)"
              type="number"
              min="0.01"
              max={advanceApplicationLimit}
              step="0.01"
              value={advanceAllocation.amount}
              onChange={(event) => setAdvanceAllocation({ ...advanceAllocation, amount: event.target.value })}
              data-testid="advance-application-amount"
            />
            <div className="flex justify-end gap-2">
              <Btn variant="outline" disabled={advanceSaving} onClick={() => setAdvanceAllocation(null)}>Cancel</Btn>
              <Btn
                variant="success"
                disabled={advanceSaving || !advanceAllocation.invoice_id || !(advanceApplicationLimit > 0)}
                onClick={applyAdvancePayment}
                data-testid="confirm-advance-application"
              >{advanceSaving ? "Applying..." : "Apply to Invoice"}</Btn>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!profile && !advanceForm && !advanceAllocation} onClose={() => setProfile(null)} title={profile?.c.name} wide>
        {profile && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {priceZonesEnabled && <><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">Zone</p><p className="font-bold text-slate-800">Zone {profile.c.default_zone}</p></div>
              <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-400">Most Used Zone</p><p className="font-bold text-slate-800">{mostUsedZone(profile.invoices, profile.c.default_zone)}</p></div></>}
              <div className="rounded-lg bg-blue-50 p-3"><p className="text-xs text-slate-400">Total Invoiced</p><p className="font-mono font-bold text-slate-800">{fmtMoney(profile.total_invoiced)}</p></div>
              <div className="rounded-lg bg-red-50 p-3"><p className="text-xs text-slate-400">Outstanding</p><p className="font-mono font-bold text-red-600" data-testid="customer-outstanding">{fmtMoney(profile.invoices_outstanding)}</p></div>
              <div className="rounded-lg bg-orange-50 p-3"><p className="break-words text-xs text-slate-400">BLN FROM EXPRESS WEBSITE</p><p className="font-mono font-bold text-orange-700">{fmtMoney(profile.other_balance)}</p></div>
              <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs text-slate-400">Payments Received</p><p className="font-mono font-bold text-emerald-700">{fmtMoney(profile.payments_received)}</p></div>
            </div>
            <Card className="p-4">
              <h4 className="mb-3 text-sm font-bold text-slate-700">Edit client balances</h4>
              <div className="grid grid-cols-1 gap-3">
                <Input label="BLN FROM EXPRESS WEBSITE" type="number" min="0" step="0.01" value={otherBalance} onChange={(e) => setOtherBalance(e.target.value)} data-testid="customer-other-balance" />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="text-xs text-slate-500 hover:text-primary hover:underline" onClick={toggleExpressBalance} data-testid="toggle-express-balance-btn">
                  {profile.c.other_balance_express ? "Remove from Express Balances and Payments" : "Express Balances and Payments"}
                </button>
                <Btn variant="success" onClick={saveOtherBalance} data-testid="save-other-balance-btn">Save balances</Btn>
              </div>
            </Card>
            <Card className="space-y-3 p-4" data-testid="customer-advance-payments">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-slate-700">Advance payments</h4>
                  <p className="text-xs text-slate-500">Available credit: <b>{fmtMoney(availableAdvancePayments.reduce((total, payment) => total + Number(payment.available_amount || 0), 0))}</b></p>
                </div>
                <Btn variant="success" onClick={openAdvancePayment} data-testid="record-advance-payment">
                  <Plus size={15} /> Record advance payment
                </Btn>
              </div>
              {availableAdvancePayments.length > 0 ? (
                <div className="space-y-2">
                  {availableAdvancePayments.map((payment) => (
                    <div key={payment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                      <span className="text-slate-500">
                        {fmtDate(payment.date)} · {payment.method} · Received {fmtMoney(payment.amount)} · Available {fmtMoney(payment.available_amount)}
                      </span>
                      {!unpaidInvoicesForAdvance(payment).length && <span className="text-xs text-slate-500">
                        No issued {payment.express ? "Express" : "Standard"} invoice with an outstanding balance.
                      </span>}
                      <Btn
                        variant="outline"
                        disabled={!unpaidInvoicesForAdvance(payment).length}
                        onClick={() => openAdvanceAllocation(payment)}
                        data-testid={`apply-advance-payment-${payment.id}`}
                      >Apply to invoice</Btn>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-slate-400">No advance credit available.</p>}
              {!profile.invoices.some((invoice) => !["draft", "void"].includes(invoice.status) && Number(invoice.outstanding) > 0)
                && <p className="text-xs text-slate-500">The customer needs an issued invoice with an outstanding balance before credit can be applied.</p>}
            </Card>
            {otherBalancePayments.length > 0 && (
              <section>
                <h4 className="mb-1.5 text-xs font-bold text-slate-700">Other Balance Payments</h4>
                <div className="space-y-1">{otherBalancePayments.map((p, idx) => (
                  <div key={p.id || p.payment_id || idx} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs ${p.reversed ? "opacity-60" : ""}`}>
                    <span className="text-slate-500">
                      {fmtDate(p.date)} · {p.method || "Other balance"} · Other balance
                      {p.reversed && <span className="ml-2 font-semibold text-red-600">Reversed</span>}
                      {p.archived && <span className="ml-2 font-semibold text-slate-500">Archived invoice</span>}
                    </span>
                    <span className={`font-mono font-semibold ${p.reversed ? "line-through text-slate-400" : "text-emerald-600"}`}>
                      {fmtMoney(p.amount)}
                    </span>
                  </div>
                ))}</div>
              </section>
            )}
            <div>
              <h4 className="font-bold text-slate-700 mb-2 text-sm">Invoice History</h4>
              {profile.invoices.length === 0 ? <p className="text-sm text-slate-400">No invoices.</p> : (
                <div className="space-y-1.5">{profile.invoices.map((i) => (
                  <div key={i.id} className="flex items-center justify-between text-sm border border-border rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-50" onClick={() => nav(`/invoices/${i.id}`)}>
                    <span className="font-mono font-semibold">{i.number || "DRAFT"}{i.opening_balance && <span className="ml-2 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 font-sans">Opening Balance</span>}</span>
                    <span className="text-slate-500">{fmtDate(i.date)}</span>
                    <span className="font-mono">{fmtMoney(i.total)}</span>
                    <Badge cls={STATUS_META[i.status]?.cls}>{STATUS_META[i.status]?.label}</Badge>
                  </div>))}</div>
              )}
            </div>
            <div>
              <h4 className="font-bold text-slate-700 mb-2 text-sm">Payments</h4>
              {profile.payments.length === 0 ? <p className="text-sm text-slate-400">No payments.</p> : (
                <div className="space-y-1.5">{profile.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm border border-border rounded-lg px-3 py-2">
                    <span>
                      {fmtDate(p.date)} · {p.method}
                      {p.advance_payment && <span className="ml-1 text-slate-500">· Advance payment</span>}
                      {p.advance_allocation && <span className="ml-1 text-slate-500">· Applied to invoice {p.invoice_number || ""}</span>}
                      {p.reversed && <span className="ml-2 font-semibold text-red-600">Reversed</span>}
                      {p.archived && <span className="ml-2 font-semibold text-slate-500">Archived invoice</span>}
                    </span>
                    <span className={`font-mono font-semibold ${p.reversed ? "line-through text-slate-400" : "text-emerald-600"}`}>{fmtMoney(p.amount)}</span>
                  </div>))}</div>
              )}
            </div>
            <div className="flex justify-end"><Btn onClick={() => nav("/invoices/new")}><Plus size={16} /> New Invoice</Btn></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
