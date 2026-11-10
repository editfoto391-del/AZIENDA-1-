import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { Building2, CircleAlert, Download, LoaderCircle, Plus, RefreshCw, Send } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { companyProfileName } from "@/lib/company";
import { InvoiceDocument } from "@/components/InvoiceDocument";
import { elementToPdf } from "@/lib/pdf";
import { documentFilename } from "@/lib/format";
import { useAuth } from "@/context/AuthContext";

const COMPANIES = [
  { id: "superiqfoam", name: "SUPERIQFOAM" },
  { id: "iqfoam-manufactoring", name: "IQFOAM MANUFACTURING" },
  { id: "iqfoam-whole-sallers", name: "IQFOAM WHOLESALERS" },
];

const STATUS_STYLE = {
  PENDING: "bg-amber-100 text-amber-800",
  ACCEPTED: "bg-sky-100 text-sky-800",
  REJECTED: "bg-rose-100 text-rose-800",
  INVOICE_CREATED: "bg-violet-100 text-violet-800",
  INVOICE_SENT: "bg-emerald-100 text-emerald-800",
};

const money = (value) => new Intl.NumberFormat("en-ZA", {
  style: "currency", currency: "ZAR",
}).format(Number(value || 0));

function companyName(id) {
  return COMPANIES.find((company) => company.id === id)?.name || companyProfileName(id);
}

function intercompanyError(error) {
  const detail = error.response?.data?.detail;
  if (!detail || typeof detail !== "object" || typeof detail.message !== "string") {
    return apiError(error);
  }
  const shortages = (detail.shortages || []).map((item) =>
    `${item.product} ${item.dimensions}: ${item.available} available, ${item.requested} requested`,
  );
  return [detail.message, ...shortages].join(" ");
}

const intercompanyProductLabel = (product) => [product.product, product.dimensions].filter(Boolean).join(" · ");

function Panel({ title, children, icon: Icon }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4">
        {Icon && <Icon size={18} className="text-emerald-700" />}
        <h2 className="font-semibold text-foreground">{title}</h2>
      </div>
      <div className="min-w-0 p-4 sm:p-5">{children}</div>
    </section>
  );
}

export default function Intercompany() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const companyId = user?.company_id;
  const isAdmin = !user?.is_worker && (
    user?.is_owner || user?.role === "admin" || user?.company_roles?.[companyId] === "admin"
  );
  const suppliers = COMPANIES.filter((company) => company.id !== companyId);
  const [requests, setRequests] = useState([]);
  const [requestPage, setRequestPage] = useState(1);
  const [requestTotal, setRequestTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || "");
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [draftItems, setDraftItems] = useState([{ stock_id: "", quantity: "1" }]);
  const [notes, setNotes] = useState("");
  const [confirmInvoice, setConfirmInvoice] = useState(null);
  const [invoiceProductSearch, setInvoiceProductSearch] = useState("");
  const [invoiceProducts, setInvoiceProducts] = useState([]);
  const [invoiceProductsLoading, setInvoiceProductsLoading] = useState(false);
  const [invoicePdfBusy, setInvoicePdfBusy] = useState(false);
  const invoiceDocumentRef = useRef(null);

  const loadRequests = useCallback(async (page = 1) => {
    setError("");
    try {
      const result = await api.get("/intercompany/requests", { page, page_size: 30 });
      setRequests(result.items || []);
      setRequestPage(result.page || page);
      setRequestTotal(result.total || 0);
    } catch (requestError) {
      setError(intercompanyError(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  useEffect(() => {
    const requestId = searchParams.get("requestId");
    if (!requestId) return;
    let active = true;
    api.get(`/intercompany/requests/${requestId}`).then((request) => {
      if (active) setSelectedRequest(request);
    }).catch((requestError) => {
      if (active) toast.error(intercompanyError(requestError));
    }).finally(() => {
      if (active) setSearchParams({}, { replace: true });
    });
    return () => { active = false; };
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!supplierId) return undefined;
    let active = true;
    setProductsLoading(true);
    api.get("/intercompany/products", {
      supplying_company_id: supplierId, q: search, page: 1, page_size: 100,
    }).then((result) => {
      if (active) {
        setProducts(result.items || []);
      }
    }).catch((requestError) => {
      if (active) {
        setProducts([]);
        toast.error(intercompanyError(requestError));
      }
    }).finally(() => { if (active) setProductsLoading(false); });
    return () => { active = false; };
  }, [supplierId, search]);

  useEffect(() => {
    const supplyingCompanyId = confirmInvoice?.request?.supplying_company_id;
    if (confirmInvoice?.step !== "create" || !supplyingCompanyId) {
      setInvoiceProducts([]);
      setInvoiceProductsLoading(false);
      return undefined;
    }
    let active = true;
    setInvoiceProductsLoading(true);
    api.get("/intercompany/products", {
      supplying_company_id: supplyingCompanyId,
      q: invoiceProductSearch,
      page: 1,
      page_size: 100,
    }).then((result) => {
      if (active) setInvoiceProducts(result.items || []);
    }).catch((requestError) => {
      if (active) {
        setInvoiceProducts([]);
        toast.error(intercompanyError(requestError));
      }
    }).finally(() => {
      if (active) setInvoiceProductsLoading(false);
    });
    return () => { active = false; };
  }, [confirmInvoice?.step, confirmInvoice?.request?.supplying_company_id, invoiceProductSearch]);

  const updateLine = (index, key, value) => {
    setDraftItems((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, [key]: value } : item,
    ));
  };

  const createRequest = async (event) => {
    event.preventDefault();
    const combinedItems = new Map();
    draftItems.forEach((item) => {
      const current = combinedItems.get(item.stock_id) || 0;
      combinedItems.set(item.stock_id, current + Number(item.quantity));
    });
    const items = [...combinedItems].map(([stock_id, quantity]) => ({ stock_id, quantity }));
    if (!supplierId || items.some((item) => !item.stock_id || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      toast.error("Choose a supplier, product and valid quantity for each line.");
      return;
    }
    setBusy("create-request");
    try {
      await api.post("/intercompany/requests", {
        supplying_company_id: supplierId, items, notes,
      });
      setDraftItems([{ stock_id: "", quantity: "1" }]);
      setSearch("");
      setNotes("");
      toast.success("Intercompany request submitted.");
      await loadRequests(requestPage);
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const refreshRequest = async (requestId) => {
    const result = await api.get(`/intercompany/requests/${requestId}`);
    setSelectedRequest(result);
    await loadRequests(requestPage);
    return result;
  };

  const reviewItem = async (requestId, itemId) => {
    setBusy(requestId);
    try {
      await api.post(`/intercompany/requests/${requestId}/items/review`, { item_id: itemId });
      toast.success("Product identity review completed.");
      await refreshRequest(requestId);
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const acceptRequest = async (request) => {
    setBusy(request.id);
    try {
      await api.post(`/intercompany/requests/${request.id}/accept`, {});
      const updated = await refreshRequest(request.id);
      setInvoiceProductSearch("");
      setConfirmInvoice({
        request: updated,
        step: "create",
        quantities: Object.fromEntries((updated.items || []).map((item) => [item.id, String(item.quantity)])),
        additionalItems: [],
      });
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const rejectRequest = async (request) => {
    const reason = window.prompt("Enter the reason for rejecting this request:");
    if (!reason?.trim()) return;
    setBusy(request.id);
    try {
      await api.post(`/intercompany/requests/${request.id}/reject`, { reason: reason.trim() });
      toast.success("Request rejected.");
      await refreshRequest(request.id);
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const createInvoice = async (request, send, invoiceQuantities, additionalItems = []) => {
    setBusy(request.id);
    try {
      await api.post(`/intercompany/requests/${request.id}/invoice`, {
        send_to_requesting_company: send,
        ...(!send ? {
          items: request.items.map((item) => ({
            item_id: item.id,
            quantity: Number(invoiceQuantities[item.id]),
          })).concat(additionalItems.map((item) => ({
            stock_id: item.stock_id,
            quantity: Number(item.quantity),
          }))),
        } : {}),
      });
      toast.success(send ? "Invoice created and sent." : "Invoice created; it has not been sent.");
      const updated = await refreshRequest(request.id);
      setConfirmInvoice(send ? null : { request: updated, step: "send" });
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const viewInvoice = async (request) => {
    setBusy(request.id);
    try {
      const invoiceDetails = await api.get(`/intercompany/requests/${request.id}/invoice`);
      setSelectedRequest({ ...request, invoice_details: invoiceDetails });
    } catch (requestError) {
      toast.error(intercompanyError(requestError));
    } finally {
      setBusy("");
    }
  };

  const downloadInvoicePdf = async () => {
    if (!invoiceDocumentRef.current || !selectedRequest?.invoice_details) return;
    setInvoicePdfBusy(true);
    try {
      const { invoice } = selectedRequest.invoice_details;
      const filename = `${documentFilename("Invoice", invoice.number, invoice.customer_name)}.pdf`;
      await elementToPdf(invoiceDocumentRef.current, filename);
      toast.success("Invoice PDF downloaded.");
    } catch (pdfError) {
      toast.error(pdfError.message || "Could not download the invoice PDF.");
    } finally {
      setInvoicePdfBusy(false);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Purchasing</p>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Intercompany Requests</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Request products from another company. The supplier reviews each request, and invoices use the supplier's saved price list.
          </p>
        </div>
        <button type="button" onClick={() => loadRequests()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-muted disabled:opacity-50" data-testid="intercompany-refresh">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(20rem,0.88fr)_minmax(0,1.62fr)]">
      <Panel title="Create a request" icon={Plus}>
        <form onSubmit={createRequest} className="space-y-4">
          <div className="grid gap-4">
            <label className="space-y-1 text-sm font-medium text-slate-700">
              Supplying company
              <select value={supplierId} onChange={(event) => {
                setSupplierId(event.target.value);
                setDraftItems([{ stock_id: "", quantity: "1" }]);
                setSearch("");
              }} className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">
                {suppliers.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          </div>
          {draftItems.map((item, index) => (
            <div key={index} className="grid min-w-0 gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
              <label className="space-y-1 text-sm font-medium text-slate-700">
                Product {index + 1}
                <input
                  type="search"
                  value={item.search ?? (item.selected_product ? intercompanyProductLabel(item.selected_product) : "")}
                  onChange={(event) => {
                    const value = event.target.value;
                    const selectedProduct = products.find((product) =>
                      intercompanyProductLabel(product).toLowerCase() === value.trim().toLowerCase()
                    ) || null;
                    setSearch(value);
                    setDraftItems((current) => current.map((line, lineIndex) =>
                      lineIndex === index
                        ? {
                          ...line,
                          search: value,
                          stock_id: selectedProduct?.stock_id || "",
                          selected_product: selectedProduct,
                        }
                        : line,
                    ));
                  }}
                  list={`intercompany-product-options-${index}`}
                  placeholder={productsLoading ? "Loading supplier stock..." : "Search product or dimensions"}
                  className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm"
                  data-testid={`intercompany-product-search-${index}`}
                />
                <datalist id={`intercompany-product-options-${index}`}>
                  {products.map((product) => <option key={product.stock_id} value={intercompanyProductLabel(product)} />)}
                  {item.selected_product && !products.some((product) => product.stock_id === item.stock_id) && (
                    <option value={intercompanyProductLabel(item.selected_product)} />
                  )}
                </datalist>
                {productsLoading && <span className="block text-xs font-normal text-slate-500" role="status">Searching supplier stock...</span>}
                {!productsLoading && search.trim() && products.length === 0 && <span className="block text-xs font-normal text-slate-500" role="status">No matching products.</span>}
              </label>
              <label className="space-y-1 text-sm font-medium text-slate-700">
                Quantity
                <input type="number" min="0.001" step="any" value={item.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
              </label>
              {draftItems.length > 1 && <button type="button" onClick={() => setDraftItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="self-end rounded-lg px-3 py-2 text-sm text-rose-700 hover:bg-rose-50">Remove</button>}
            </div>
          ))}
          <div className="grid gap-3">
            <button type="button" disabled={draftItems.length >= 100} onClick={() => {
              setSearch("");
              setDraftItems((current) => [...current, { stock_id: "", quantity: "1" }]);
            }} className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"><Plus size={15} /> Add product</button>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} placeholder="Optional notes for the supplier" className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
            <button disabled={busy === "create-request"} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
              {busy === "create-request" ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />} Submit request
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="Requests" icon={Building2}>
        {error && <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><CircleAlert size={16} />{error}</div>}
        {loading ? <div className="flex items-center gap-2 text-sm text-slate-500"><LoaderCircle size={17} className="animate-spin" /> Loading requests...</div>
          : requests.length === 0 ? <p className="text-sm text-slate-500">No intercompany requests yet.</p>
            : <div className="min-w-0">
              <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground"><tr>
                  <th className="px-3 py-3">Request</th><th className="px-3 py-3">Direction</th><th className="px-3 py-3 text-center">Products</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Created</th><th className="px-3 py-3">Actions</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {requests.map((request) => {
                    const isSupplier = request.supplying_company_id === companyId;
                    const isRequester = request.requesting_company_id === companyId;
                    const canReview = isAdmin && isSupplier && request.status === "PENDING";
                    const canCreateInvoice = isAdmin && isSupplier && ["ACCEPTED", "INVOICE_CREATED"].includes(request.status);
                    return <tr key={request.id}>
                      <td className="whitespace-nowrap px-3 py-3 font-semibold text-foreground">#{request.id.slice(-8)}</td>
                      <td className="px-3 py-3">{isSupplier ? `From ${companyName(request.requesting_company_id)}` : `To ${companyName(request.supplying_company_id)}`}</td>
                      <td className="px-3 py-3 text-center tabular-nums">{request.items?.length || 0}</td>
                      <td className="whitespace-nowrap px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[request.status] || "bg-slate-100 text-slate-700"}`}>{request.status.replaceAll("_", " ")}</span></td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{request.created_at ? new Date(request.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-nowrap gap-2 whitespace-nowrap">
                          <button type="button" onClick={() => setSelectedRequest(request)} className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-slate-50">Details</button>
                          {canReview && <><button type="button" disabled={busy === request.id} onClick={() => acceptRequest(request)} className="rounded-md bg-emerald-700 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-60">Accept</button><button type="button" disabled={busy === request.id} onClick={() => rejectRequest(request)} className="rounded-md border border-rose-200 px-2.5 py-1.5 text-xs text-rose-700 disabled:opacity-60">Reject</button></>}
                          {canCreateInvoice && <button type="button" onClick={() => {
                            setInvoiceProductSearch("");
                            setConfirmInvoice({
                              request,
                              step: request.status === "INVOICE_CREATED" ? "send" : "create",
                              quantities: Object.fromEntries((request.items || []).map((item) => [item.id, String(item.quantity)])),
                              additionalItems: [],
                            });
                          }} className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white">{request.status === "INVOICE_CREATED" ? "Send invoice" : "Create invoice"}</button>}
                          {request.status === "INVOICE_SENT" && (isRequester || isSupplier) && <button type="button" disabled={busy === request.id} onClick={() => viewInvoice(request)} className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-slate-50">View invoice</button>}
                        </div>
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>{requestTotal ? `Showing ${(requestPage - 1) * 30 + 1}–${Math.min(requestPage * 30, requestTotal)} of ${requestTotal}` : "No requests"}</span>
                <div className="flex gap-2">
                  <button type="button" disabled={requestPage <= 1} onClick={() => loadRequests(requestPage - 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40">Previous</button>
                  <button type="button" disabled={requestPage * 30 >= requestTotal} onClick={() => loadRequests(requestPage + 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40">Next</button>
                </div>
              </div>
            </div>}
      </Panel>
      </div>

      {selectedRequest && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="intercompany-detail-title">
        <div className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div><h2 id="intercompany-detail-title" className="text-lg font-bold">Request details</h2><p className="mt-1 text-sm text-slate-500">{companyName(selectedRequest.requesting_company_id)} → {companyName(selectedRequest.supplying_company_id)}</p></div>
            <button type="button" onClick={() => setSelectedRequest(null)} className="rounded-md border px-3 py-1.5 text-sm">Close</button>
          </div>
          <div className="mt-4 space-y-3">
            {(selectedRequest.items || []).map((item) => <div key={item.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap justify-between gap-2"><strong>{item.product} · {item.dimensions}</strong><span>Qty {item.quantity}</span></div>
              <p className="mt-1 text-xs text-slate-500">Supplier stock available when requested: {item.available_quantity_at_request}</p>
              {item.manual_review && selectedRequest.supplying_company_id === companyId && isAdmin && selectedRequest.status === "PENDING" && <button type="button" disabled={busy === selectedRequest.id} onClick={() => reviewItem(selectedRequest.id, item.id)} className="mt-2 rounded-md border border-amber-300 px-2.5 py-1.5 text-xs font-medium text-amber-800">Confirm product identity</button>}
            </div>)}
          </div>
          {selectedRequest.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700"><strong>Notes:</strong> {selectedRequest.notes}</p>}
          {selectedRequest.rejection_reason && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><strong>Rejection reason:</strong> {selectedRequest.rejection_reason}</p>}
          {selectedRequest.invoice_details && (() => {
            const { invoice, settings, customer } = selectedRequest.invoice_details;
            const totals = {
              subtotal: invoice.subtotal || 0,
              tax: invoice.tax_amount || 0,
              total: invoice.total || 0,
              outstanding: invoice.outstanding || 0,
            };
            return <section className="mt-5 space-y-3" aria-label="Intercompany invoice preview">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 p-4">
                <div className="text-sm">
                  <h3 className="font-semibold">Intercompany invoice {invoice.number}</h3>
                  <p className="mt-1">{invoice.customer_name} · Total {money(invoice.total)}</p>
                </div>
                <button type="button" onClick={downloadInvoicePdf} disabled={invoicePdfBusy} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60" data-testid="intercompany-invoice-download">
                  {invoicePdfBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
                  {invoicePdfBusy ? "Preparing PDF..." : "Download PDF"}
                </button>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 p-3">
                <InvoiceDocument
                  ref={invoiceDocumentRef}
                  inv={invoice}
                  totals={totals}
                  customer={customer}
                  settings={settings}
                />
              </div>
            </section>;
          })()}
        </div>
      </div>}

      {confirmInvoice && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="intercompany-invoice-title">
        <div className="w-full max-w-xl rounded-xl bg-white p-6 shadow-xl">
          <h2 id="intercompany-invoice-title" className="text-lg font-bold">{confirmInvoice.step === "create" ? "Create intercompany invoice?" : "Send intercompany invoice?"}</h2>
          <p className="mt-2 text-sm text-slate-600">{confirmInvoice.step === "create"
            ? `The invoice will use the supplier's saved price list and its customer record for your company.`
            : `The created invoice will be released to ${companyName(confirmInvoice.request.requesting_company_id)}. Once sent, the requesting company can view its details.`}</p>
          {confirmInvoice.step === "create" && <div className="mt-4 space-y-3">
            <p className="text-sm font-semibold text-slate-700">Invoice quantities (change them if the delivered pieces differ from the request)</p>
            {confirmInvoice.request.items.map((item) => <label key={item.id} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 text-sm">
              <span className="min-w-0 text-slate-700">{intercompanyProductLabel(item)} <span className="text-slate-400">(requested {item.quantity})</span></span>
              <input
                type="number"
                min="0.001"
                max="1000000"
                step="any"
                value={confirmInvoice.quantities[item.id] ?? ""}
                onChange={(event) => setConfirmInvoice((current) => ({
                  ...current,
                  quantities: { ...current.quantities, [item.id]: event.target.value },
                }))}
                aria-label={`Invoice quantity for ${intercompanyProductLabel(item)}`}
                data-testid={`intercompany-invoice-quantity-${item.id}`}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>)}
            <div className="space-y-3 border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-700">Add products from supplier stock</p>
                <button
                  type="button"
                  disabled={(confirmInvoice.additionalItems || []).length + confirmInvoice.request.items.length >= 100}
                  onClick={() => setConfirmInvoice((current) => {
                    if (!current) return current;
                    const additionalItems = current.additionalItems || [];
                    return {
                      ...current,
                      additionalItems: [...additionalItems, {
                      key: `new-product-${Date.now()}-${additionalItems.length}`,
                      stock_id: "",
                      quantity: "1",
                      }],
                    };
                  })}
                  className="rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                  data-testid="intercompany-invoice-add-product"
                >
                  <Plus size={14} className="mr-1 inline" /> Add product
                </button>
              </div>
              {(confirmInvoice.additionalItems || []).length > 0 && <>
                <input
                  type="search"
                  value={invoiceProductSearch}
                  onChange={(event) => setInvoiceProductSearch(event.target.value)}
                  placeholder="Search supplier products"
                  aria-label="Search supplier products to add to invoice"
                  data-testid="intercompany-invoice-product-search"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                {invoiceProductsLoading && <p className="text-xs text-slate-500" role="status">Loading supplier products...</p>}
                {!invoiceProductsLoading && invoiceProducts.length === 0 && <p className="text-xs text-slate-500" role="status">No supplier products found.</p>}
                {(confirmInvoice.additionalItems || []).map((line, index) => (
                  <div key={line.key} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2">
                    <label className="min-w-0 space-y-1 text-xs font-medium text-slate-600">
                      Product
                      <select
                        value={line.stock_id}
                        onChange={(event) => setConfirmInvoice((current) => current && ({
                          ...current,
                          additionalItems: current.additionalItems.map((item, itemIndex) =>
                            itemIndex === index ? {
                              ...item,
                              stock_id: event.target.value,
                              selected_product: invoiceProducts.find((product) => product.stock_id === event.target.value) || null,
                            } : item,
                          ),
                        }))}
                        data-testid={`intercompany-invoice-product-${index}`}
                        className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
                      >
                        <option value="">{invoiceProductsLoading ? "Loading..." : "Select product"}</option>
                        {invoiceProducts.filter((product) => (
                          (Number(product.available_quantity) > 0 || product.stock_id === line.stock_id)
                          && (product.stock_id === line.stock_id
                            || !(confirmInvoice.additionalItems || []).some((other, otherIndex) =>
                              otherIndex !== index && other.stock_id === product.stock_id))
                        )).concat(line.selected_product
                          && !invoiceProducts.some((product) => product.stock_id === line.stock_id)
                          ? [line.selected_product]
                          : []).map((product) => (
                          <option key={product.stock_id} value={product.stock_id}>
                            {intercompanyProductLabel(product)} · {Number(product.available_quantity || 0)} available
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs font-medium text-slate-600">
                      Quantity
                      <input
                        type="number"
                        min="0.001"
                        max="1000000"
                        step="any"
                        value={line.quantity}
                        onChange={(event) => setConfirmInvoice((current) => current && ({
                          ...current,
                          additionalItems: current.additionalItems.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, quantity: event.target.value } : item,
                          ),
                        }))}
                        aria-label={`Additional product quantity ${index + 1}`}
                        data-testid={`intercompany-invoice-product-quantity-${index}`}
                        className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setConfirmInvoice((current) => current && ({
                        ...current,
                        additionalItems: current.additionalItems.filter((item) => item.key !== line.key),
                      }))}
                      className="rounded-lg px-2 py-2 text-xs text-rose-700 hover:bg-rose-50"
                      aria-label={`Remove additional product ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </>}
            </div>
          </div>}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setConfirmInvoice(null)} className="rounded-lg border px-3 py-2 text-sm">Cancel</button>
            {confirmInvoice.step === "send" && <button type="button" onClick={() => setConfirmInvoice(null)} className="rounded-lg border px-3 py-2 text-sm">Keep unsent</button>}
            <button type="button" disabled={busy === confirmInvoice.request.id || (confirmInvoice.step === "create" && (
              confirmInvoice.request.items.some((item) => !Number.isFinite(Number(confirmInvoice.quantities[item.id])) || Number(confirmInvoice.quantities[item.id]) <= 0)
              || (confirmInvoice.additionalItems || []).some((item) => !item.stock_id || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || Number(item.quantity) > 1_000_000)
            ))} onClick={() => createInvoice(confirmInvoice.request, confirmInvoice.step === "send", confirmInvoice.quantities, confirmInvoice.additionalItems)} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white">
              {confirmInvoice.step === "create" ? "Create invoice" : "Send invoice"}
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}
