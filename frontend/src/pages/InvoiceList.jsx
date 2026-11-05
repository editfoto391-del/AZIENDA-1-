import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fmtMoney, fmtDate, fmtDateTime, STATUS_META } from "@/lib/format";
import { Card, Btn, Input, Badge, PageHeader, Empty, Modal } from "@/components/common";
import { Eye, FileText, Search, Plus, Pencil, Trash2, Download, RotateCcw, Archive, MessageCircle, Link2Off } from "lucide-react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { usesUnifiedPriceList } from "@/lib/company";

const normalizeWhatsAppPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return `27${digits.slice(1)}`;
  return digits;
};

export default function InvoiceList({ express = false }) {
  const { user } = useAuth();
  const isInvoiceOwner = user?.is_owner || user?.is_company_owner || user?.role === "owner";
  const canManageInvoices = user?.is_admin || user?.role === "admin" || user?.is_owner
    || (user?.is_worker && user?.allowed_sections?.includes(express ? "express-invoices" : "invoices")
      && user?.write_permissions?.[express ? "express-invoices" : "invoices"]?.delete !== "deny");
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") || "");
  const [debouncedQ, setDebouncedQ] = useState(sp.get("q") || "");
  const [status, setStatus] = useState("all");
  const [zone, setZone] = useState("all");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const nav = useNavigate();
  const [sel, setSel] = useState([]);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewInvoice, setViewInvoice] = useState(null);
  const [viewCustomer, setViewCustomer] = useState(null);
  const [whatsappDraft, setWhatsappDraft] = useState(null);
  const detailRequest = useRef(0);
  const listPath = express ? "/express-invoices" : "/invoices";
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
    setSel([]);
    api.get("/invoices", {
      express,
      include_archived: showArchived,
      page,
      page_size: 50,
      q: debouncedQ,
      status,
      zone: zone === "all" ? undefined : zone,
      invoice_date: invoiceDate || undefined,
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
  }, [express, showArchived, page, debouncedQ, status, zone, invoiceDate, user?.company_id, reload]);

  useEffect(() => {
    setList([]);
    setTotal(0);
    setPage(1);
    setSel([]);
    setViewOpen(false);
    setViewInvoice(null);
    setViewCustomer(null);
    detailRequest.current += 1;
  }, [user?.company_id]);

  const load = () => setReload((current) => current + 1);

  const view = async (id) => {
    const requestId = ++detailRequest.current;
    setViewOpen(true);
    setViewLoading(true);
    setViewInvoice(null);
    setViewCustomer(null);
    let invoiceLoaded = false;
    try {
      const invoice = await api.get(`/invoices/${id}`);
      if (detailRequest.current !== requestId) return;
      setViewInvoice(invoice);
      invoiceLoaded = true;
      const customer = invoice.customer_deleted
        ? null
        : await api.get(`/customers/${invoice.customer_id}`);
      if (detailRequest.current !== requestId) return;
      setViewCustomer(customer);
    } catch (error) {
      if (detailRequest.current !== requestId) return;
      toast.error(invoiceLoaded ? `Invoice loaded, but customer details could not be loaded: ${apiError(error)}` : apiError(error));
      if (!invoiceLoaded) setViewOpen(false);
    } finally {
      if (detailRequest.current === requestId) setViewLoading(false);
    }
  };

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const removeMany = async (ids) => {
    if (!window.confirm(`Delete ${ids.length} invoice(s)?`)) return;
    const restoreStock = window.confirm("Also re-add the invoiced quantities to stock? Choose Cancel to archive without changing stock.");
    try {
      const r = await api.post("/invoices/bulk-delete", { ids, restore_stock: restoreStock });
      toast.success(isInvoiceOwner
        ? `${r.archived} invoice(s) moved to Archived${r.stock_restored ? " and stock returned" : ""}`
        : `${r.archived} invoice(s) deleted${r.stock_restored ? " and stock returned" : ""}`);
      load();
    } catch (e) { toast.error(apiError(e)); }
  };
  const archiveMany = async (ids) => {
    if (!window.confirm(`Archive ${ids.length} invoice(s)? They and their payment records will be retained and can be restored.`)) return;
    const restoreStock = window.confirm("Also re-add the invoiced quantities to stock? Choose Cancel to archive without changing stock.");
    try {
      const r = await api.post("/invoices/bulk-delete", { ids, restore_stock: restoreStock });
      toast.success(isInvoiceOwner
        ? `${r.archived} invoice(s) archived${r.stock_restored ? " and stock returned" : ""}`
        : `${r.archived} invoice(s) deleted${r.stock_restored ? " and stock returned" : ""}`);
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
  const setDailyReportInclusion = async (invoice) => {
    const included = !invoice.include_on_daily_report;
    try {
      await api.post(`/invoices/${invoice.id}/daily-report`, { included });
      setList((current) => current.map((item) => item.id === invoice.id
        ? { ...item, include_on_daily_report: included }
        : item));
      toast.success(included ? "Invoice included on the daily report" : "Invoice removed from the daily report");
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const permanentlyDeleteMany = async (ids) => {
    if (!showArchived || ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} archived invoice(s)? This cannot be undone and their payment records will also be deleted.`)) return;
    try {
      const result = await api.post("/invoices/bulk-permanent-delete", { ids });
      setSel([]);
      toast.success(`${result.deleted} archived invoice(s) permanently deleted`);
      load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const sendInvoiceViaWhatsApp = async (event, invoice) => {
    event.stopPropagation();
    const requestId = ++detailRequest.current;
    try {
      const customer = await api.get(`/customers/${invoice.customer_id}`);
      if (detailRequest.current !== requestId) return;
      const phone = normalizeWhatsAppPhone(customer?.phone);
      if (!phone) throw new Error("This customer does not have a valid phone number.");

      const { token } = await api.post(`/invoices/${invoice.id}/share-link`, {});
      const link = `${window.location.origin}/shared-invoice/${encodeURIComponent(token)}`;
      const message = `Hello ${invoice.customer_name || ""}, view or download your invoice PDF ${invoice.number || ""} here: ${link}`;
      setWhatsappDraft({
        url: `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
        invoiceNumber: invoice.number || "DRAFT",
      });
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const revokeInvoiceShareLink = async (event, invoice) => {
    event.stopPropagation();
    if (!window.confirm(`Revoke the shared link for invoice ${invoice.number || "DRAFT"}? Anyone using the old link will lose access.`)) return;
    try {
      await api.del(`/invoices/${invoice.id}/share-link`);
      setList((current) => current.map((item) => item.id === invoice.id ? { ...item, has_share_link: false } : item));
      toast.success("Invoice share link revoked.");
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / 50));
  const rangeStart = total === 0 ? 0 : (page - 1) * 50 + 1;
  const rangeEnd = Math.min(page * 50, total);

  return (
    <div>
      <PageHeader title={express ? "Express Website Invoices" : "Invoices"} subtitle={loading ? "Loading invoices..." : `Showing ${rangeStart}–${rangeEnd} of ${total} invoices`}>
        <Btn onClick={() => nav(`${listPath}/new`)} data-testid="new-invoice-btn"><Plus size={16} /> Create Invoice</Btn>
      </PageHeader>

      <Card className={`p-4 mb-4 grid grid-cols-1 ${unifiedPriceList ? "sm:grid-cols-4" : "sm:grid-cols-5"} gap-3`}>
        <div className="relative sm:col-span-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input data-testid="invoice-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number or customer..."
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary" />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-lg border border-input px-3 py-2.5 text-sm" data-testid="invoice-status-filter">
          <option value="all">All Statuses</option>
          {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <Input label="Invoice date" type="date" value={invoiceDate} onChange={(e) => { setInvoiceDate(e.target.value); setPage(1); }} data-testid="invoice-date-filter" />
        {!unifiedPriceList && <select value={zone} onChange={(e) => { setZone(e.target.value); setPage(1); }} className="rounded-lg border border-input px-3 py-2.5 text-sm">
          <option value="all">All Zones</option><option value="1">Zone 1</option><option value="2">Zone 2</option>
        </select>}
        {isInvoiceOwner && <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); setPage(1); }} />
            Show archived invoices
        </label>}
      </Card>

      {canManageInvoices && sel.length > 0 && <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2" data-testid="bulk-bar">
        <span className="text-sm font-semibold text-amber-800">{sel.length} selected</span>
        <Btn variant="danger" onClick={() => showArchived ? permanentlyDeleteMany(sel) : removeMany(sel)} data-testid="bulk-delete-btn">
          <Trash2 size={15} /> {showArchived ? "Permanently delete selected" : "Delete selected"}
        </Btn>
      </div>}

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading invoices...</p> : list.length === 0 ? <Empty icon={FileText} title="No invoices found" hint="Create your first invoice to get started." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                {canManageInvoices && <th className="px-3 py-3 w-8"><input type="checkbox" checked={sel.length > 0 && sel.length === list.filter((i) => showArchived ? i.archived : !i.archived && i.status === "draft").length} onChange={(e) => setSel(e.target.checked ? list.filter((i) => showArchived ? i.archived : !i.archived && i.status === "draft").map((i) => i.id) : [])} data-testid="select-all-invoices" /></th>}<th className="px-4 py-3 font-semibold">Invoice</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">Date</th><th className="px-4 font-semibold">Due</th>{!unifiedPriceList && <th className="px-4 font-semibold">Zone</th>}<th className="px-4 font-semibold text-right">Total</th><th className="px-4 font-semibold text-right">Paid</th><th className="px-4 font-semibold text-right">Balance</th><th className="px-4 font-semibold text-center">Status</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{list.map((i) => (
                <tr key={i.id} className="border-b border-border/60 hover:bg-slate-50 cursor-pointer" onClick={() => i.archived ? view(i.id) : nav(`${listPath}/${i.id}`)} data-testid={`invoice-row-${i.id}`}>
                  {canManageInvoices && <td className="px-3" onClick={(e) => e.stopPropagation()}>{(showArchived ? i.archived : !i.archived && i.status === "draft") && <input type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} data-testid={`select-invoice-${i.id}`} />}</td>}
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
                      <button onClick={(e) => { e.stopPropagation(); nav(`${listPath}/${i.id}?pdf=1`); }} data-testid={`pdf-invoice-row-${i.id}`} title="Download PDF" className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:border-primary hover:text-primary transition-colors">
                        <Download size={12} />
                      </button>
                      {i.status !== "draft" && i.status !== "void" && <button
                        onClick={(e) => sendInvoiceViaWhatsApp(e, i)}
                        data-testid={`whatsapp-invoice-row-${i.id}`}
                        title="Send invoice via WhatsApp"
                        aria-label={`Send invoice ${i.number || "draft"} via WhatsApp`}
                        className="ml-2 inline-flex items-center justify-center rounded-lg border border-emerald-200 bg-white p-1.5 text-emerald-700 hover:bg-emerald-50 transition-colors"
                      >
                        <MessageCircle size={12} />
                      </button>}
                      {i.has_share_link && <button
                        onClick={(e) => revokeInvoiceShareLink(e, i)}
                        data-testid={`revoke-whatsapp-invoice-row-${i.id}`}
                        title="Revoke shared invoice link"
                        aria-label={`Revoke shared invoice link for ${i.number || "invoice"}`}
                        className="ml-2 inline-flex items-center justify-center rounded-lg border border-red-200 bg-white p-1.5 text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Link2Off size={12} />
                      </button>}
                      <button onClick={(e) => { e.stopPropagation(); nav(`${listPath}/${i.id}?edit=1`); }} data-testid={`edit-invoice-row-${i.id}`}
                        className="ml-2 inline-flex items-center gap-1 rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-blue-50 transition-colors">
                        <Pencil size={12} /> Edit
                      </button>
                      {express && i.number && i.status !== "void" && <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDailyReportInclusion(i); }}
                        aria-pressed={!!i.include_on_daily_report}
                        data-testid={`daily-report-inclusion-${i.id}`}
                        className={`ml-2 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${i.include_on_daily_report ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-600 hover:border-primary hover:text-primary"}`}
                      >
                        {i.include_on_daily_report ? "Included in daily report" : "Include on daily report"}
                      </button>}
                    </>
                  )}
                    {canManageInvoices && !i.archived && <>
                      {isInvoiceOwner && <button onClick={(e) => { e.stopPropagation(); archiveMany([i.id]); }} data-testid={`archive-invoice-row-${i.id}`} title="Archive invoice" aria-label={`Archive invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-amber-200 px-2 py-1 text-amber-700 hover:bg-amber-50"><Archive size={12} /><span>Archive</span></button>}
                      <button onClick={(e) => { e.stopPropagation(); removeMany([i.id]); }} data-testid={`delete-invoice-row-${i.id}`} title={`Delete invoice ${i.number || "draft"}`} aria-label={`Delete invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"><Trash2 size={12} /><span>Delete</span></button>
                    </>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="invoice-pagination">
        <p className="text-sm text-slate-500">
          Showing {rangeStart}–{rangeEnd} of {total.toLocaleString()} invoices
        </p>
        <div className="flex items-center gap-2">
          <Btn variant="outline" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} data-testid="invoice-previous-page">Previous</Btn>
          <span className="min-w-24 text-center text-sm text-slate-600">Page {page} of {pageCount}</span>
          <Btn variant="outline" disabled={loading || page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} data-testid="invoice-next-page">Next</Btn>
        </div>
      </div>

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
              ...(viewInvoice.payment_terms === "Cash on Delivery" ? [
                ["Cash to collect", viewInvoice.cod_amount_due != null ? fmtMoney(viewInvoice.cod_amount_due) : "—"],
                ["Cash collected", viewInvoice.cod_amount_collected != null ? fmtMoney(viewInvoice.cod_amount_collected) : "—"],
              ] : []),
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
            {[["Subtotal", viewInvoice.subtotal], ["Discount", viewInvoice.discount], ...(Number(viewInvoice.delivery_fee) ? [["Delivery Fee", viewInvoice.delivery_fee]] : []), ["Additional Charges", viewInvoice.extra_charges], ...(viewInvoice.tax_enabled ? [["Tax", viewInvoice.tax_amount]] : []), ["Total", viewInvoice.total], ["Amount Paid", viewInvoice.amount_paid], ["Outstanding Balance", viewInvoice.outstanding]].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4"><span className="font-semibold text-slate-600">{label}</span><span className="font-mono">{fmtMoney(value)}</span></div>
            ))}
          </div>
          {(viewInvoice.made_by || viewInvoice.client_number || viewInvoice.assigned_driver_name) && <div className="grid gap-3 sm:grid-cols-3 text-sm">
            {viewInvoice.made_by && <p><span className="font-semibold text-slate-600">Made By:</span> {viewInvoice.made_by}</p>}
            {viewInvoice.client_number && <p><span className="font-semibold text-slate-600">Client Number:</span> {viewInvoice.client_number}</p>}
            {viewInvoice.assigned_driver_name && <p><span className="font-semibold text-slate-600">Assigned Driver:</span> {viewInvoice.assigned_driver_name}</p>}
          </div>}
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

      <Modal
        open={!!whatsappDraft}
        onClose={() => setWhatsappDraft(null)}
        title={`Invoice ${whatsappDraft?.invoiceNumber || ""} ready`}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            The invoice link is ready. Open WhatsApp to review the message, then press Send.
          </p>
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setWhatsappDraft(null)}>Cancel</Btn>
            <a
              href={whatsappDraft?.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setWhatsappDraft(null)}
              data-testid="open-invoice-whatsapp"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              <MessageCircle size={15} /> Open WhatsApp
            </a>
          </div>
        </div>
      </Modal>
    </div>
  );
}
