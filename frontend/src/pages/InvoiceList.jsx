import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fmtMoney, fmtDate, fmtDateTime, STATUS_META } from "@/lib/format";
import { Card, Btn, Input, Badge, PageHeader, Empty, Modal } from "@/components/common";
import { Eye, FileText, Search, Plus, Pencil, Trash2, Download, RotateCcw, Archive } from "lucide-react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { usesUnifiedPriceList } from "@/lib/company";

export default function InvoiceList() {
  const { user } = useAuth();
  const canManageInvoices = user?.is_admin || user?.role === "admin" || user?.is_owner;
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") || "");
  const [status, setStatus] = useState("all");
  const [zone, setZone] = useState("all");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const nav = useNavigate();
  const [sel, setSel] = useState([]);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewInvoice, setViewInvoice] = useState(null);
  const [viewCustomer, setViewCustomer] = useState(null);
  const customersRequest = useRef(null);
  const loadCustomers = () => {
    if (!customersRequest.current) {
      customersRequest.current = api.get("/customers").catch((error) => {
        customersRequest.current = null;
        throw error;
      });
    }
    return customersRequest.current;
  };
  const load = () => api.get(showArchived ? "/invoices?include_archived=true" : "/invoices")
    .then((d) => { setList(d); setSel([]); })
    .catch((e) => toast.error(apiError(e)))
    .finally(() => setLoading(false));
  useEffect(() => {
    load();
    loadCustomers().catch((error) => toast.error(apiError(error)));
  }, [showArchived]);

  const view = async (id) => {
    setViewOpen(true);
    setViewLoading(true);
    setViewInvoice(null);
    setViewCustomer(null);
    let invoiceLoaded = false;
    try {
      const invoice = await api.get(`/invoices/${id}`);
      setViewInvoice(invoice);
      invoiceLoaded = true;
      const customers = await loadCustomers();
      setViewCustomer(customers.find((customer) => customer.id === invoice.customer_id) || null);
    } catch (error) {
      toast.error(invoiceLoaded ? `Invoice loaded, but customer details could not be loaded: ${apiError(error)}` : apiError(error));
      if (!invoiceLoaded) setViewOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const removeMany = async (ids) => {
    if (!window.confirm(`Delete ${ids.length} invoice(s)? They will be moved to Archived, not permanently erased. Invoice data and payments are retained and can be restored.`)) return;
    const restoreStock = window.confirm("Also re-add the invoiced quantities to stock? Choose Cancel to archive without changing stock.");
    try {
      const r = await api.post("/invoices/bulk-delete", { ids, restore_stock: restoreStock });
      toast.success(`${r.archived} invoice(s) moved to Archived${r.stock_restored ? " and stock returned" : ""}`);
      load();
    } catch (e) { toast.error(apiError(e)); }
  };
  const archiveMany = async (ids) => {
    if (!window.confirm(`Archive ${ids.length} invoice(s)? They and their payment records will be retained and can be restored.`)) return;
    const restoreStock = window.confirm("Also re-add the invoiced quantities to stock? Choose Cancel to archive without changing stock.");
    try {
      const r = await api.post("/invoices/bulk-delete", { ids, restore_stock: restoreStock });
      toast.success(`${r.archived} invoice(s) archived${r.stock_restored ? " and stock returned" : ""}`);
      load();
    } catch (e) { toast.error(apiError(e)); }
  };
  const restore = async (id) => {
    try {
      await api.post(`/invoices/${id}/restore`);
      toast.success("Invoice restored");
      load();
    } catch (e) { toast.error(apiError(e)); }
  };
  const permanentlyDelete = async (invoice) => {
    if (!showArchived || !invoice.archived) return;
    if (!window.confirm(`Permanently delete invoice ${invoice.number || "DRAFT"} for ${invoice.customer_name}? This cannot be undone and its payment records will also be deleted.`)) return;
    try {
      await api.del(`/invoices/${invoice.id}/permanent`);
      toast.success("Invoice permanently deleted");
      if (viewInvoice?.id === invoice.id) setViewOpen(false);
      load();
    } catch (e) { toast.error(apiError(e)); }
  };

  const filtered = list.filter((i) => {
    if (showArchived && !i.archived) return false;
    const text = `${i.number || ""} ${i.customer_name}`.toLowerCase();
    return text.includes(q.toLowerCase()) &&
      (status === "all" || i.status === status) &&
      (!invoiceDate || i.date === invoiceDate) &&
      (zone === "all" || String(i.zone) === zone);
  });

  return (
    <div>
      <PageHeader title="Invoices" subtitle={loading ? "Loading invoices..." : `${list.length} invoices`}>
        <Btn onClick={() => nav("/invoices/new")} data-testid="new-invoice-btn"><Plus size={16} /> Create Invoice</Btn>
      </PageHeader>

      <Card className={`p-4 mb-4 grid grid-cols-1 ${unifiedPriceList ? "sm:grid-cols-4" : "sm:grid-cols-5"} gap-3`}>
        <div className="relative sm:col-span-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input data-testid="invoice-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or customer..."
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-input px-3 py-2.5 text-sm" data-testid="invoice-status-filter">
          <option value="all">All Statuses</option>
          {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <Input label="Invoice date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} data-testid="invoice-date-filter" />
        {!unifiedPriceList && <select value={zone} onChange={(e) => setZone(e.target.value)} className="rounded-lg border border-input px-3 py-2.5 text-sm">
          <option value="all">All Zones</option><option value="1">Zone 1</option><option value="2">Zone 2</option>
        </select>}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived invoices
        </label>
      </Card>

      {canManageInvoices && sel.length > 0 && <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2" data-testid="bulk-bar">
        <span className="text-sm font-semibold text-amber-800">{sel.length} selected</span>
        <Btn variant="danger" onClick={() => removeMany(sel)} data-testid="bulk-delete-btn"><Trash2 size={15} /> Delete selected</Btn>
      </div>}

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading invoices...</p> : filtered.length === 0 ? <Empty icon={FileText} title="No invoices found" hint="Create your first invoice to get started." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                {canManageInvoices && <th className="px-3 py-3 w-8"><input type="checkbox" checked={sel.length > 0 && sel.length === filtered.filter((i) => !i.archived && i.status === "draft").length} onChange={(e) => setSel(e.target.checked ? filtered.filter((i) => !i.archived && i.status === "draft").map((i) => i.id) : [])} data-testid="select-all-invoices" /></th>}<th className="px-4 py-3 font-semibold">Invoice</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">Date</th><th className="px-4 font-semibold">Due</th>{!unifiedPriceList && <th className="px-4 font-semibold">Zone</th>}<th className="px-4 font-semibold text-right">Total</th><th className="px-4 font-semibold text-right">Paid</th><th className="px-4 font-semibold text-right">Balance</th><th className="px-4 font-semibold text-center">Status</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{filtered.map((i) => (
                <tr key={i.id} className="border-b border-border/60 hover:bg-slate-50 cursor-pointer" onClick={() => i.archived ? view(i.id) : nav(`/invoices/${i.id}`)} data-testid={`invoice-row-${i.id}`}>
                  {canManageInvoices && <td className="px-3" onClick={(e) => e.stopPropagation()}>{!i.archived && i.status === "draft" && <input type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} data-testid={`select-invoice-${i.id}`} />}</td>}
                  <td className="px-4 py-3 font-mono font-semibold text-slate-700">{i.number || "DRAFT"}{i.archived && <span className="ml-2 inline-block rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 font-sans">Archived</span>}{i.opening_balance && <span className="ml-2 inline-block rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 font-sans" data-testid={`opening-badge-${i.id}`}>Opening Balance</span>}</td>
                  <td className="px-4 text-slate-600">{i.customer_name}{i.customer_deleted && <Badge cls="ml-2 border-red-200 bg-red-50 text-red-700">Deleted customer</Badge>}</td>
                  <td className="px-4 text-slate-500">{fmtDate(i.date)}</td>
                  <td className="px-4 text-slate-500">{fmtDate(i.due_date)}</td>
                  {!unifiedPriceList && <td className="px-4"><Badge cls="bg-blue-50 text-blue-700 border-blue-200">Z{i.zone}</Badge></td>}
                  <td className="px-4 text-right font-mono text-slate-700">{fmtMoney(i.total)}</td>
                  <td className="px-4 text-right font-mono text-emerald-600">{fmtMoney(i.amount_paid)}</td>
                  <td className="px-4 text-right font-mono text-red-600">{fmtMoney(i.outstanding)}</td>
                  <td className="px-4 text-center"><Badge cls={STATUS_META[i.status]?.cls}>{STATUS_META[i.status]?.label}</Badge></td>
                  <td className="px-4 text-right">
                    <button onClick={(e) => { e.stopPropagation(); view(i.id); }} data-testid={`view-invoice-row-${i.id}`} title="View invoice" aria-label={`View invoice ${i.number || "draft"}`} className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:border-primary hover:text-primary transition-colors">
                      <Eye size={12} />
                    </button>
                    {i.archived ? (
                      <>
                        {canManageInvoices && <>
                          <button onClick={(e) => { e.stopPropagation(); restore(i.id); }} data-testid={`restore-invoice-row-${i.id}`} title="Restore invoice" aria-label={`Restore invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center rounded-lg border border-emerald-200 px-2 py-1 text-emerald-700 hover:bg-emerald-50"><RotateCcw size={12} /></button>
                          {showArchived && <button onClick={(e) => { e.stopPropagation(); permanentlyDelete(i); }} data-testid={`permanently-delete-invoice-row-${i.id}`} title="Permanently delete invoice" aria-label={`Permanently delete invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"><Trash2 size={12} /><span>Delete permanently</span></button>}
                        </>}
                      </>
                    ) : i.status !== "void" && (
                      <>
                      <button onClick={(e) => { e.stopPropagation(); nav(`/invoices/${i.id}?pdf=1`); }} data-testid={`pdf-invoice-row-${i.id}`} title="Download PDF" className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:border-primary hover:text-primary transition-colors">
                        <Download size={12} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); nav(`/invoices/${i.id}?edit=1`); }} data-testid={`edit-invoice-row-${i.id}`}
                        className="ml-2 inline-flex items-center gap-1 rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-blue-50 transition-colors">
                        <Pencil size={12} /> Edit
                      </button>
                    </>
                  )}
                    {canManageInvoices && !i.archived && <>
                      <button onClick={(e) => { e.stopPropagation(); archiveMany([i.id]); }} data-testid={`archive-invoice-row-${i.id}`} title="Archive invoice" aria-label={`Archive invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-amber-200 px-2 py-1 text-amber-700 hover:bg-amber-50"><Archive size={12} /><span>Archive</span></button>
                      <button onClick={(e) => { e.stopPropagation(); removeMany([i.id]); }} data-testid={`delete-invoice-row-${i.id}`} title="Delete invoice (move to archive)" aria-label={`Delete invoice ${i.number || "draft"} (move to archive)`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"><Trash2 size={12} /><span>Delete</span></button>
                    </>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={viewOpen} onClose={() => setViewOpen(false)} title={`Invoice Details ${viewInvoice?.number || ""}`} wide>
        {viewLoading ? <p className="text-sm text-slate-500" role="status">Loading invoice details...</p> : viewInvoice && <div className="space-y-5 text-sm" data-testid={`invoice-details-${viewInvoice.id}`}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            {[
              ["Invoice Number", viewInvoice.number || "DRAFT"],
              ["Customer", `${viewInvoice.customer_name || ""}${viewInvoice.customer_deleted ? " (Deleted customer)" : ""}`],
              ["Address", viewCustomer?.address],
              ["City", viewCustomer?.city],
              ["Phone", viewCustomer?.phone],
              ["Email", viewCustomer?.email],
              ["Issue Date", fmtDate(viewInvoice.date)],
              ["Due Date", fmtDate(viewInvoice.due_date)],
              ...(!unifiedPriceList ? [["Price Zone", `Zone ${viewInvoice.zone}`]] : []),
              ["Payment Terms", viewInvoice.payment_terms],
              ["Reference", viewInvoice.reference],
              ["Destination", viewInvoice.destination],
              ["Status", STATUS_META[viewInvoice.status]?.label || viewInvoice.status],
              ["Tax Rate", viewInvoice.tax_enabled ? `${viewInvoice.tax_rate}%` : ""],
              ["Related Orders", viewInvoice.order_ids?.join(", ")],
              ["Invoice Type", viewInvoice.opening_balance ? "Opening Balance" : "Standard"],
              ["Created", viewInvoice.created_at ? fmtDateTime(viewInvoice.created_at) : ""],
            ].filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => (
              <div key={label}><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-800">{value}</dd></div>
            ))}
          </dl>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Items</h4>
            {(viewInvoice.items || []).length ? <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Product / Description</th><th className="px-3 py-2">Size</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Unit Price</th><th className="px-3 py-2 text-right">Line Total</th></tr></thead>
                <tbody>{viewInvoice.items.map((item, index) => <tr key={index} className="border-t border-border/70">
                  <td className="px-3 py-2">{item.category || item.description || "Item"}</td><td className="px-3 py-2">{item.size || "-"}</td>
                  <td className="px-3 py-2 text-right">{item.qty}</td><td className="px-3 py-2 text-right">{fmtMoney(item.unit_price)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(item.line_total ?? (Number(item.qty || 0) * Number(item.unit_price || 0)))}</td>
                </tr>)}</tbody>
              </table>
            </div> : <p className="text-slate-500">{viewInvoice.opening_balance ? "Opening balance invoice" : "No invoice items recorded."}</p>}
          </div>
          <div className="ml-auto max-w-sm space-y-2 rounded-lg bg-slate-50 p-4">
            {[["Subtotal", viewInvoice.subtotal], ["Discount", viewInvoice.discount], ["Additional Charges", viewInvoice.extra_charges], ...(viewInvoice.tax_enabled ? [["Tax", viewInvoice.tax_amount]] : []), ["Total", viewInvoice.total], ["Amount Paid", viewInvoice.amount_paid], ["Outstanding Balance", viewInvoice.outstanding]].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4"><span className="font-semibold text-slate-600">{label}</span><span className="font-mono">{fmtMoney(value)}</span></div>
            ))}
          </div>
          {viewInvoice.payment_records?.length > 0 && <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Payments</h4>
            <div className="space-y-2">{viewInvoice.payment_records.map((payment) => <div key={payment.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span>{fmtDate(payment.date)}{payment.method ? ` · ${payment.method}` : ""}</span><span className="font-mono font-semibold">{fmtMoney(payment.amount)}</span>
              {(payment.reference || payment.notes) && <span className="w-full text-xs text-slate-500">{[payment.reference, payment.notes].filter(Boolean).join(" · ")}</span>}
            </div>)}</div>
          </div>}
          {viewInvoice.notes && <div><h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</h4><p className="mt-1 whitespace-pre-wrap text-slate-800">{viewInvoice.notes}</p></div>}
          {viewInvoice.audit?.length > 0 && <p className="text-xs text-slate-500">Last updated: {fmtDateTime(viewInvoice.audit[viewInvoice.audit.length - 1].at)}</p>}
        </div>}
      </Modal>
    </div>
  );
}
