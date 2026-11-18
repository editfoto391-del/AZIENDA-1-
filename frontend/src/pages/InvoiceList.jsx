import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fmtMoney, fmtDate, fmtDateTime, STATUS_META, documentFilename, today } from "@/lib/format";
import { Card, Btn, Input, Badge, PageHeader, Empty, Modal } from "@/components/common";
import { Eye, FileText, Search, Plus, Pencil, Trash2, Download, RotateCcw, Archive, MessageCircle, Link2Off, RefreshCw, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { companyProfileName, usesFreeformInvoiceItems, usesPriceZones } from "@/lib/company";
import { resolveWhatsAppPhone } from "@/lib/whatsappPhone.mjs";
import { InvoiceDocument } from "@/components/InvoiceDocument";
import { elementToPdf } from "@/lib/pdf";

const receivedInvoicesSeenKey = (companyId) => `received-invoices-seen:${companyId || "default"}`;
const receivedInvoiceItems = (invoice) => (invoice?.items || [])
  .filter((item) => (item.category || item.size || item.description)
    && !(!item.category && !item.size && item.description?.trim().toLowerCase() === "opening balance"))
  .map((item, index) => ({ ...item, key: String(index) }));
const receivedInvoiceItemName = (item) => (item.category || item.description || "").trim();
const receivedInvoiceItemMeasure = (item) => {
  const size = String(item.size || "").trim();
  const measure = size.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/);
  return {
    capacity: Number(String(item.capacity ?? measure?.[1] ?? "").replace(",", ".")),
    unit: String(item.unit || measure?.[2] || "").trim(),
  };
};

export default function InvoiceList({ express = false }) {
  const { user } = useAuth();
  const isInvoiceOwner = user?.is_owner || user?.is_company_owner || user?.role === "owner";
  const canAccessInvoiceArchive = Boolean(isInvoiceOwner);
  const canManageInvoices = user?.is_admin || user?.role === "admin" || user?.is_owner
    || (user?.is_worker && user?.allowed_sections?.includes(express ? "express-invoices" : "invoices")
      && user?.write_permissions?.[express ? "express-invoices" : "invoices"]?.delete !== "deny");
  const priceZonesEnabled = usesPriceZones(user?.company_id);
  const freeformInvoiceItems = usesFreeformInvoiceItems(user?.company_id);
  const [list, setList] = useState([]);
  const [section, setSection] = useState("invoices");
  const [receivedInvoices, setReceivedInvoices] = useState([]);
  const [receivedLoading, setReceivedLoading] = useState(false);
  const [receivedReload, setReceivedReload] = useState(0);
  const [receivedInvoiceReceipt, setReceivedInvoiceReceipt] = useState(null);
  const [receivedInvoiceDetails, setReceivedInvoiceDetails] = useState(null);
  const [receivedInvoiceLoading, setReceivedInvoiceLoading] = useState(false);
  const [seenReceivedInvoiceIds, setSeenReceivedInvoiceIds] = useState([]);
  const [receivedGRVAssignments, setReceivedGRVAssignments] = useState({});
  const [receivedGRVExpanded, setReceivedGRVExpanded] = useState(false);
  const [receivedGRVBusy, setReceivedGRVBusy] = useState(false);
  const [receivedInvoicePdfBusy, setReceivedInvoicePdfBusy] = useState(false);
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
  const [permanentDeleteRequest, setPermanentDeleteRequest] = useState(null);
  const [viewCustomer, setViewCustomer] = useState(null);
  const [whatsappDraft, setWhatsappDraft] = useState(null);
  const [pdfDownload, setPdfDownload] = useState(null);
  const [pdfBusyId, setPdfBusyId] = useState("");
  const detailRequest = useRef(0);
  const pdfDocumentRef = useRef(null);
  const receivedInvoiceDocumentRef = useRef(null);
  const receivedInvoicesLoadedRef = useRef(false);
  const receivedInvoicesCompanyRef = useRef(user?.company_id);
  const pdfBusyRef = useRef(false);
  const pdfDownloadStartedRef = useRef("");
  const listPath = express ? "/express-invoices" : "/invoices";

  useEffect(() => {
    if (express) return undefined;
    if (receivedInvoicesCompanyRef.current !== user?.company_id) {
      receivedInvoicesCompanyRef.current = user?.company_id;
      receivedInvoicesLoadedRef.current = false;
      setReceivedInvoices([]);
    }
    if (section !== "receiving" && receivedInvoicesLoadedRef.current) return undefined;
    let active = true;
    const loadReceivedInvoices = async () => {
      if (!receivedInvoicesLoadedRef.current) setReceivedLoading(true);
      try {
        const result = await api.getUncached("/intercompany/invoices/received");
        if (!Array.isArray(result)) throw new Error("The received invoice list response is not valid.");
        if (active) {
          setReceivedInvoices(result);
          receivedInvoicesLoadedRef.current = true;
        }
      } catch (error) {
        if (!active) return;
        toast.error(`Could not load received invoices: ${apiError(error)}`);
      } finally {
        if (active) setReceivedLoading(false);
      }
    };
    loadReceivedInvoices();
    return () => {
      active = false;
    };
  }, [express, section, receivedReload, user?.company_id]);

  useEffect(() => {
    if (express) return;
    try {
      const saved = JSON.parse(localStorage.getItem(receivedInvoicesSeenKey(user?.company_id)) || "[]");
      if (!Array.isArray(saved) || saved.some((id) => typeof id !== "string")) {
        throw new Error("Saved received invoice notification state is invalid.");
      }
      setSeenReceivedInvoiceIds(saved);
    } catch (error) {
      setSeenReceivedInvoiceIds([]);
      toast.error(`Could not load received invoice notification state: ${error.message}`);
    }
  }, [express, user?.company_id]);

  const markReceivedInvoiceSeen = (receiptId) => {
    const next = [...new Set([...seenReceivedInvoiceIds, receiptId])];
    try {
      localStorage.setItem(receivedInvoicesSeenKey(user?.company_id), JSON.stringify(next));
      setSeenReceivedInvoiceIds(next);
    } catch (error) {
      toast.error(`Could not update received invoice notification state: ${error.message}`);
    }
  };

  const openReceivedInvoice = async (receipt, openGRV = false) => {
    setReceivedInvoiceReceipt(receipt);
    setReceivedInvoiceDetails(null);
    setReceivedGRVAssignments({});
    setReceivedGRVExpanded(openGRV);
    setReceivedInvoiceLoading(true);
    try {
      const details = await api.getUncached(
        `/intercompany/invoices/received/${encodeURIComponent(receipt.id)}`,
      );
      const invoiceId = details.invoice_details?.invoice?.id;
      setReceivedInvoiceDetails({
        ...details,
        receipt,
        items: receivedInvoiceItems(details.invoice_details?.invoice),
        existingGrvs: [],
      });
      markReceivedInvoiceSeen(receipt.id);
      try {
        const grvs = await api.getUncached("/grvs");
        if (!Array.isArray(grvs)) throw new Error("The GRV list response is not valid.");
        setReceivedInvoiceDetails((current) => current && ({
          ...current,
          existingGrvs: grvs.filter((grv) => grv.source_intercompany_invoice_id === invoiceId),
        }));
      } catch (error) {
        toast.error(`Invoice opened, but linked GRVs could not be loaded: ${apiError(error)}`);
      }
    } catch (error) {
      setReceivedInvoiceReceipt(null);
      toast.error(`Could not open received invoice: ${apiError(error)}`);
    } finally {
      setReceivedInvoiceLoading(false);
    }
  };

  const createReceivedInvoiceGRVs = async () => {
    const selected = receivedInvoiceDetails;
    const invoice = selected?.invoice_details?.invoice;
    const items = selected?.items || [];
    if (!selected || !invoice || !items.length) {
      toast.error("This invoice has no product lines to add to a GRV.");
      return;
    }
    if (items.some((item) => !receivedGRVAssignments[item.key])) {
      toast.error("Choose a destination for every invoice line.");
      return;
    }
    const groups = new Map();
    items.forEach((item, index) => {
      const category = receivedGRVAssignments[item.key];
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push({ item, index });
    });
    const existingCategories = new Set(
      (selected.existingGrvs || []).map((grv) => grv.source_intercompany_category),
    );
    const missingGroups = [...groups].filter(([category]) => !existingCategories.has(category));
    if (!missingGroups.length) {
      toast.info("A GRV already exists for each selected destination.");
      return;
    }

    setReceivedGRVBusy(true);
    const created = [];
    try {
      const needsSellingStock = missingGroups.some(([category]) => category === "selling_product");
      const stock = needsSellingStock ? await api.getUncached("/stock") : [];
      if (needsSellingStock && !Array.isArray(stock)) throw new Error("The stock list response is not valid.");
      const payloads = [];
      for (const [category, entries] of missingGroups) {
        const isChemical = category === "chemical";
        const lines = entries.map(({ item, index }) => {
          const product = receivedInvoiceItemName(item);
          const quantity = Number(item.qty);
          if (!product || !Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Invoice line ${index + 1} needs a product name and a positive quantity.`);
          }
          const measure = receivedInvoiceItemMeasure(item);
          if (isChemical && (!Number.isFinite(measure.capacity) || measure.capacity <= 0 || !measure.unit)) {
            throw new Error(`Invoice line ${index + 1} needs a numeric chemical capacity and unit (for example 25 L).`);
          }
          const line = {
            product,
            size: isChemical ? String(measure.capacity) : String(item.size || "").trim(),
            actual_received_quantity: quantity,
            accepted_quantity: quantity,
            rejected_quantity: 0,
            damaged_quantity: 0,
            unit_cost: Number(item.unit_price) || 0,
          };

          if (category === "selling_product") {
            const existing = stock.find((candidate) =>
              String(candidate.product || "").trim().toLowerCase() === product.toLowerCase()
              && String(candidate.size || "").trim().toLowerCase() === line.size.toLowerCase(),
            );
            return existing
              ? { ...line, stock_id: existing.id, product_code: existing.code || existing.sku || existing.id }
              : { ...line, new_product: true };
          }
          return {
            ...line,
            category: isChemical ? "Chemical" : (item.category || "Other"),
            unit: measure.unit || String(item.unit || "pcs").trim(),
            container_type: item.container_type || "Barrel",
          };
        });
        payloads.push({
          purpose: category === "selling_product" ? "selling" : "raw_material",
          is_chemical: isChemical,
          source_intercompany_invoice_id: invoice.id,
          source_intercompany_category: category,
          supplier_name: selected.invoice_details.settings?.company_name
            || companyProfileName(selected.supplying_company_id),
          delivery_note_number: invoice.number || "",
          received_date: invoice.date || today(),
          received_by: user?.name || user?.email || "",
          notes: `Created from intercompany invoice ${invoice.number || ""}`.trim(),
          vat_rate: 0,
          items: lines,
        });
      }
      for (const payload of payloads) created.push(await api.post("/grvs", payload));
      setReceivedInvoiceDetails((current) => current && ({
        ...current,
        existingGrvs: [
          ...(current.existingGrvs || []),
          ...created.filter((grv) => !current.existingGrvs?.some((existing) => existing.id === grv.id)),
        ],
      }));
      toast.success(`${created.length} GRV draft${created.length === 1 ? "" : "s"} created.`);
      setReceivedGRVExpanded(false);
    } catch (error) {
      const detail = error.response?.data?.detail;
      const message = typeof detail === "string" ? detail : error.message || apiError(error);
      const partial = created.length
        ? ` ${created.length} GRV draft${created.length === 1 ? "" : "s"} were already created.`
        : "";
      toast.error(`${message}${partial}`);
    } finally {
      setReceivedGRVBusy(false);
    }
  };
  const downloadReceivedInvoicePdf = async () => {
    const invoice = receivedInvoiceDetails?.invoice_details?.invoice;
    if (!invoice || !receivedInvoiceDocumentRef.current) return;
    setReceivedInvoicePdfBusy(true);
    try {
      await elementToPdf(
        receivedInvoiceDocumentRef.current,
        `${documentFilename("Invoice", invoice.number, invoice.customer_name)}.pdf`,
      );
      toast.success("Invoice PDF downloaded.");
    } catch (error) {
      toast.error(error.message || "Could not download the received invoice.");
    } finally {
      setReceivedInvoicePdfBusy(false);
    }
  };
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
      include_archived: showArchived && canAccessInvoiceArchive,
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
  }, [express, showArchived, canAccessInvoiceArchive, page, debouncedQ, status, zone, invoiceDate, user?.company_id, reload]);

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

  const downloadInvoicePdf = async (event, invoiceRow) => {
    event.stopPropagation();
    if (pdfBusyRef.current) return;
    pdfBusyRef.current = true;
    pdfDownloadStartedRef.current = "";
    setPdfBusyId(invoiceRow.id);
    try {
      const [invoice, settings] = await Promise.all([
        api.getUncached(`/invoices/${invoiceRow.id}`),
        api.get("/settings"),
      ]);
      let customer = {
        phone: invoice.customer_phone || "",
        city: invoice.customer_city || "",
        address: invoice.customer_address || "",
      };
      if (invoice.customer_id && !invoice.customer_deleted) {
        customer = { ...customer, ...await api.getUncached(`/customers/${invoice.customer_id}`) };
      }
      setPdfDownload({ invoice, settings, customer });
    } catch (error) {
      pdfBusyRef.current = false;
      setPdfBusyId("");
      toast.error(`Could not prepare invoice PDF: ${apiError(error)}`);
    }
  };

  useEffect(() => {
    if (!pdfDownload || !pdfDocumentRef.current) return;
    if (pdfDownloadStartedRef.current === pdfDownload.invoice.id) return;
    pdfDownloadStartedRef.current = pdfDownload.invoice.id;
    const download = async () => {
      try {
        const { invoice } = pdfDownload;
        await elementToPdf(
          pdfDocumentRef.current,
          `${documentFilename("Invoice", invoice.customer_name || "Customer", invoice.number || "Draft")}.pdf`,
        );
        setPdfDownload(null);
      } catch (error) {
        toast.error(`Could not generate the invoice PDF: ${error.message}`);
        setPdfDownload(null);
      } finally {
        pdfBusyRef.current = false;
        setPdfBusyId("");
      }
    };
    download();
  }, [pdfDownload]);

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
  const permanentlyDelete = async (reversePayments) => {
    if (!permanentDeleteRequest || !canAccessInvoiceArchive || !showArchived) return;
    try {
      if (permanentDeleteRequest.ids.length === 1) {
        const [id] = permanentDeleteRequest.ids;
        const invoice = permanentDeleteRequest.invoices[0];
        const result = await api.del(`/invoices/${id}/permanent?reverse_payments=${reversePayments}`);
        toast.success(`Invoice ${invoice?.number || "DRAFT"} permanently deleted${result.payments_reversed ? ` and ${result.payments_reversed} payment(s) reversed` : ""}`);
        if (viewInvoice?.id === id) setViewOpen(false);
      } else {
        const result = await api.post("/invoices/bulk-permanent-delete", {
          ids: permanentDeleteRequest.ids,
          reverse_payments: reversePayments,
        });
        toast.success(`${result.deleted} archived invoice(s) permanently deleted${reversePayments ? ` and ${result.payments_reversed} payment(s) reversed` : ""}`);
        setSel([]);
      }
      setPermanentDeleteRequest(null);
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
  const requestPermanentDeleteMany = (ids) => {
    if (!canAccessInvoiceArchive || !showArchived || ids.length === 0) return;
    const invoices = ids.map((id) => list.find((invoice) => invoice.id === id)).filter(Boolean);
    setPermanentDeleteRequest({
      ids,
      invoices,
      hasPaymentHistory: invoices.some((invoice) => invoice.has_payment_history),
    });
  };
  const sendInvoiceViaWhatsApp = async (event, invoice) => {
    event.stopPropagation();
    const requestId = ++detailRequest.current;
    try {
      let customer = null;
      if (invoice.customer_id && !invoice.customer_deleted) {
        try {
          customer = await api.getUncached(`/customers/${invoice.customer_id}`);
        } catch (error) {
          if (error.response?.status !== 404) throw error;
        }
      }
      if (detailRequest.current !== requestId) return;
      let phone = resolveWhatsAppPhone(
        customer?.phone,
        invoice.customer_phone,
        invoice.phone,
        customer?.client_number,
        invoice.client_number,
      );
      if (!phone && invoice.customer_name && !invoice.customer_deleted) {
        const result = await api.getUncached("/customers", {
          page: 1,
          page_size: 50,
          q: invoice.customer_name,
        });
        if (detailRequest.current !== requestId) return;
        const exactMatch = (result.items || []).find(
          (item) => item.name?.trim().toLowerCase() === invoice.customer_name.trim().toLowerCase(),
        );
        phone = resolveWhatsAppPhone(exactMatch?.phone, exactMatch?.client_number);
      }
      if (!phone) throw new Error("This customer does not have a valid phone number.");

      const { token } = await api.post(`/invoices/${invoice.id}/share-link`, {});
      const link = `${window.location.origin}/shared-invoice/${encodeURIComponent(token)}`;
      const message = `Hello Mr/Mrs,hope you're good!\nHeres your invoice,to view it please open the following link: *${link}*`;
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
  const unseenReceivedInvoiceCount = receivedInvoices.filter(
    (receipt) => !seenReceivedInvoiceIds.includes(receipt.id),
  ).length;

  return (
    <div>
      <PageHeader title={express ? "Express Website Invoices" : "Invoices"} subtitle={loading ? "Loading invoices..." : `Showing ${rangeStart}–${rangeEnd} of ${total} invoices`}>
        <Btn onClick={() => nav(`${listPath}/new`)} data-testid="new-invoice-btn"><Plus size={16} /> Create Invoice</Btn>
      </PageHeader>

      {!express && <div className="mb-4 flex gap-2 border-b border-border" role="tablist" aria-label="Invoice sections">
        <button
          type="button"
          role="tab"
          aria-selected={section === "invoices"}
          onClick={() => setSection("invoices")}
          className={`border-b-2 px-3 py-2 text-sm font-semibold ${section === "invoices" ? "border-primary text-primary" : "border-transparent text-slate-500"}`}
          data-testid="invoices-section-tab"
        >Invoices</button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "receiving"}
          onClick={() => setSection("receiving")}
          className={`border-b-2 px-3 py-2 text-sm font-semibold ${section === "receiving" ? "border-primary text-primary" : "border-transparent text-slate-500"}`}
          data-testid="receiving-invoices-section-tab"
        >
          Receiving Invoices
          <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs" data-testid="received-invoice-count">
            {receivedInvoices.length}
          </span>
          {unseenReceivedInvoiceCount > 0 && <span
            className="ml-2 inline-flex items-center rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-[10px] font-extrabold tracking-wide text-rose-700 shadow-[0_0_8px_rgba(251,113,133,0.75)] animate-pulse"
            role="status"
            data-testid="new-invoice-received-alert"
          >NEW INVOICE RECEIVED!</span>}
        </button>
      </div>}

      {!express && section === "receiving" ? <>
        <div className="mb-3 flex justify-end">
          <Btn variant="outline" onClick={() => setReceivedReload((current) => current + 1)} disabled={receivedLoading} data-testid="received-invoices-refresh">
            <RefreshCw size={15} /> Refresh
          </Btn>
        </div>
        <Card className="overflow-hidden" data-testid="received-invoices-list">
          {receivedLoading
            ? <p className="p-6 text-sm text-slate-500" role="status">Loading received invoices...</p>
            : receivedInvoices.length === 0
              ? <Empty icon={FileText} title="No received invoices" hint="Invoices sent to this company will appear here." />
              : <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-sm">
                  <thead><tr className="border-b border-border bg-slate-50 text-xs text-slate-500">
                    <th className="px-4 py-3">Invoice</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr></thead>
                  <tbody>{receivedInvoices.map((receipt) => (
                    <tr key={receipt.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-semibold">{receipt.invoice_number || "Invoice"}</td>
                      <td className="px-4 py-3">{companyProfileName(receipt.supplying_company_id)}</td>
                      <td className="px-4 py-3">{receipt.source === "request" ? "Requested" : "Direct"}</td>
                      <td className="px-4 py-3 text-right">{fmtMoney(receipt.invoice_total || 0)}</td>
                      <td className="px-4 py-3 text-slate-500">{receipt.sent_at ? fmtDate(receipt.sent_at) : "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <Btn
                          variant="outline"
                          onClick={() => openReceivedInvoice(receipt)}
                          disabled={receivedInvoiceLoading}
                          data-testid={`received-invoice-view-${receipt.id}`}
                        ><Eye size={14} /> View invoice</Btn>
                        <Btn
                          onClick={() => openReceivedInvoice(receipt, true)}
                          disabled={receivedInvoiceLoading}
                          data-testid={`received-invoice-add-grv-${receipt.id}`}
                        >Add on GRV</Btn>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>}
        </Card>
      </> : <>
      <Card className={`p-4 mb-4 grid grid-cols-1 ${priceZonesEnabled ? "sm:grid-cols-5" : "sm:grid-cols-4"} gap-3`}>
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
        {priceZonesEnabled && <select value={zone} onChange={(e) => { setZone(e.target.value); setPage(1); }} className="rounded-lg border border-input px-3 py-2.5 text-sm">
          <option value="all">All Zones</option><option value="1">Zone 1</option><option value="2">Zone 2</option>
        </select>}
        {canAccessInvoiceArchive && <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); setPage(1); }} />
            Show archived invoices
        </label>}
      </Card>

      {canManageInvoices && (!showArchived || canAccessInvoiceArchive) && sel.length > 0 && <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2" data-testid="bulk-bar">
        <span className="text-sm font-semibold text-amber-800">{sel.length} selected</span>
        <Btn variant="danger" onClick={() => showArchived ? requestPermanentDeleteMany(sel) : removeMany(sel)} data-testid="bulk-delete-btn">
          <Trash2 size={15} /> {showArchived ? "Permanently delete selected" : "Delete selected"}
        </Btn>
      </div>}

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading invoices...</p> : list.length === 0 ? <Empty icon={FileText} title="No invoices found" hint="Create your first invoice to get started." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                {canManageInvoices && <th className="px-3 py-3 w-8"><input type="checkbox" checked={sel.length > 0 && sel.length === list.filter((i) => showArchived ? i.archived : !i.archived && i.status === "draft").length} onChange={(e) => setSel(e.target.checked ? list.filter((i) => showArchived ? i.archived : !i.archived && i.status === "draft").map((i) => i.id) : [])} data-testid="select-all-invoices" /></th>}<th className="px-4 py-3 font-semibold">Invoice</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">Date</th><th className="px-4 font-semibold">Due</th>{priceZonesEnabled && <th className="px-4 font-semibold">Zone</th>}<th className="px-4 font-semibold text-right">Total</th><th className="px-4 font-semibold text-right">Paid</th><th className="px-4 font-semibold text-right">Balance</th><th className="px-4 font-semibold text-center">Status</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{list.map((i) => (
                <tr key={i.id} className="border-b border-border/60 hover:bg-slate-50 cursor-pointer" onClick={() => i.archived ? view(i.id) : nav(`${listPath}/${i.id}`)} data-testid={`invoice-row-${i.id}`}>
                  {canManageInvoices && <td className="px-3" onClick={(e) => e.stopPropagation()}>{(showArchived ? i.archived : !i.archived && i.status === "draft") && <input type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} data-testid={`select-invoice-${i.id}`} />}</td>}
                  <td className="px-4 py-3 font-mono font-semibold text-slate-700">{i.number || "DRAFT"}{i.archived && <span className="ml-2 inline-block rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 font-sans">Archived</span>}{i.opening_balance && <span className="ml-2 inline-block rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 font-sans" data-testid={`opening-badge-${i.id}`}>Opening Balance</span>}</td>
                  <td className="px-4 text-slate-600">{i.customer_name}{i.customer_deleted && <Badge cls="ml-2 border-red-200 bg-red-50 text-red-700">Deleted customer</Badge>}</td>
                  <td className="px-4 text-slate-500">{fmtDate(i.date)}</td>
                  <td className="px-4 text-slate-500">{fmtDate(i.due_date)}</td>
                  {priceZonesEnabled && <td className="px-4"><Badge cls="bg-blue-50 text-blue-700 border-blue-200">Z{i.zone}</Badge></td>}
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
                        {canManageInvoices && canAccessInvoiceArchive && <>
                          <button onClick={(e) => { e.stopPropagation(); restore(i.id); }} data-testid={`restore-invoice-row-${i.id}`} title="Restore invoice" aria-label={`Restore invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center rounded-lg border border-emerald-200 px-2 py-1 text-emerald-700 hover:bg-emerald-50"><RotateCcw size={12} /></button>
                          {showArchived && canAccessInvoiceArchive && <button onClick={(e) => { e.stopPropagation(); setPermanentDeleteRequest({ ids: [i.id], invoices: [i], hasPaymentHistory: i.has_payment_history }); }} data-testid={`permanently-delete-invoice-row-${i.id}`} title="Permanently delete invoice" aria-label={`Permanently delete invoice ${i.number || "draft"}`} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"><Trash2 size={12} /><span>Delete permanently</span></button>}
                        </>}
                      </>
                    ) : i.status !== "void" && (
                      <>
                      <button onClick={(e) => downloadInvoicePdf(e, i)} disabled={!!pdfBusyId} data-testid={`pdf-invoice-row-${i.id}`} title="Download PDF" aria-label={`Download invoice ${i.number || "draft"} PDF`} className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:border-primary hover:text-primary transition-colors disabled:opacity-50">
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
      </>}

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
              ...(priceZonesEnabled ? [["Price Zone", `Zone ${viewInvoice.zone}`]] : []),
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
                <thead><tr className="bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">{freeformInvoiceItems ? "Product / Service" : "Product / Description"}</th>{!freeformInvoiceItems && <th className="px-3 py-2">Size</th>}<th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Unit Price</th><th className="px-3 py-2 text-right">Line Total</th></tr></thead>
                <tbody>{viewInvoice.items.map((item, index) => <tr key={index} className="border-t border-border/70">
                  <td className="px-3 py-2">{item.category || item.description || "Item"}</td>{!freeformInvoiceItems && <td className="px-3 py-2">{item.size || "-"}</td>}
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
        open={!!receivedInvoiceReceipt}
        onClose={() => {
          setReceivedInvoiceReceipt(null);
          setReceivedInvoiceDetails(null);
          setReceivedGRVExpanded(false);
          setReceivedGRVAssignments({});
        }}
        title={`${receivedGRVExpanded ? "Add on GRV · " : "Received Invoice "}${receivedInvoiceDetails?.invoice_details?.invoice?.number || receivedInvoiceReceipt?.invoice_number || ""}`}
        wide
      >
        {receivedInvoiceLoading
          ? <p className="flex items-center gap-2 text-sm text-slate-500" role="status"><LoaderCircle size={15} className="animate-spin" /> Loading invoice...</p>
          : receivedInvoiceDetails && (() => {
            const invoice = receivedInvoiceDetails.invoice_details.invoice;
            const { settings, customer } = receivedInvoiceDetails.invoice_details;
            const items = receivedInvoiceDetails.items || [];
            const existingGrvs = receivedInvoiceDetails.existingGrvs || [];
            const totals = {
              subtotal: invoice.subtotal || 0,
              tax: invoice.tax_amount || 0,
              total: invoice.total || 0,
              outstanding: invoice.outstanding || 0,
            };
            const selectedCategories = new Set(Object.values(receivedGRVAssignments).filter(Boolean));
            const allSelectedCategoriesExist = selectedCategories.size > 0
              && [...selectedCategories].every((category) => existingGrvs.some(
                (grv) => grv.source_intercompany_category === category,
              ));
            return <div className="space-y-4">
              {receivedGRVExpanded ? <>
                <div className="rounded-lg bg-emerald-50 p-4">
                  <h3 className="font-semibold">Choose a destination for each invoice product</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Invoice {invoice.number} · {invoice.customer_name} · Total {fmtMoney(invoice.total || 0)}
                  </p>
                </div>
                {existingGrvs.length > 0 && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <p className="text-sm font-semibold text-blue-900">GRVs already linked to this invoice</p>
                  <div className="mt-2 space-y-1">
                    {existingGrvs.map((grv) => <p key={grv.id} className="text-sm text-blue-800">
                      {grv.grv_number} · {grv.source_intercompany_category?.replaceAll("_", " ") || "GRV"} · {grv.status?.replaceAll("_", " ")}
                    </p>)}
                  </div>
                </div>}
                <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3" data-testid="received-invoice-grv-assignment">
                  <p className="text-sm font-medium text-slate-700">Select whether each product is a selling product, raw material, or chemical.</p>
                  {items.map((item, index) => (
                    <fieldset key={item.key} className="rounded-lg border border-slate-200 bg-white p-3">
                      <legend className="px-1 text-sm font-semibold text-slate-800">
                        {receivedInvoiceItemName(item) || `Invoice line ${index + 1}`}
                        {item.size ? ` · ${item.size}` : ""}
                        <span className="ml-2 font-normal text-slate-500">Qty {item.qty}</span>
                      </legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        {[
                          ["selling_product", "Selling product", "Stock"],
                          ["raw_material", "Raw material", "Company Inventory"],
                          ["chemical", "Chemical", "Chemical inventory"],
                        ].map(([value, label, destination]) => (
                          <label
                            key={value}
                            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${receivedGRVAssignments[item.key] === value ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:bg-slate-50"}`}
                          >
                            <input
                              type="radio"
                              name={`received-invoice-grv-category-${item.key}`}
                              value={value}
                              checked={receivedGRVAssignments[item.key] === value}
                              onChange={() => setReceivedGRVAssignments((current) => ({
                                ...current,
                                [item.key]: value,
                              }))}
                              className="mt-0.5 accent-emerald-700"
                              data-testid={`received-invoice-grv-category-${item.key}-${value}`}
                            />
                            <span>
                              <span className="block font-semibold text-slate-800">{label}</span>
                              <span className="text-xs text-slate-500">{destination}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  {allSelectedCategoriesExist && <p className="text-sm text-blue-800" role="status">
                    A GRV already exists for each selected destination. Existing GRVs will not be duplicated.
                  </p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Btn type="button" variant="outline" onClick={() => setReceivedGRVExpanded(false)}>
                    Back to invoice
                  </Btn>
                  <Btn
                    type="button"
                    onClick={createReceivedInvoiceGRVs}
                    disabled={receivedGRVBusy || !items.length || allSelectedCategoriesExist}
                    data-testid="received-invoice-create-grv-drafts"
                  >{receivedGRVBusy ? "Creating GRV drafts..." : "Create GRV drafts"}</Btn>
                </div>
              </> : <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 p-4">
                  <div className="text-sm">
                    <h3 className="font-semibold">Received invoice {invoice.number}</h3>
                    <p className="mt-1">{invoice.customer_name} · Total {fmtMoney(invoice.total || 0)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Btn
                      type="button"
                      onClick={() => setReceivedGRVExpanded(true)}
                      disabled={!items.length}
                      data-testid="received-invoice-add-on-grv"
                    >Add on GRV</Btn>
                  <Btn
                    type="button"
                    onClick={downloadReceivedInvoicePdf}
                    disabled={receivedInvoicePdfBusy}
                    data-testid="received-invoice-download"
                  >
                    {receivedInvoicePdfBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />}
                    {receivedInvoicePdfBusy ? "Preparing PDF..." : "Download PDF"}
                  </Btn>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 p-3">
                  <InvoiceDocument
                    ref={receivedInvoiceDocumentRef}
                    inv={invoice}
                    totals={totals}
                    customer={customer}
                    settings={settings}
                  />
                </div>
                {existingGrvs.length > 0 && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <p className="text-sm font-semibold text-blue-900">GRVs already linked to this invoice</p>
                  <div className="mt-2 space-y-1">
                    {existingGrvs.map((grv) => <p key={grv.id} className="text-sm text-blue-800">
                      {grv.grv_number} · {grv.source_intercompany_category?.replaceAll("_", " ") || "GRV"} · {grv.status?.replaceAll("_", " ")}
                    </p>)}
                  </div>
                </div>}
                <div className="flex justify-end">
                  <Btn variant="outline" onClick={() => {
                    setReceivedInvoiceReceipt(null);
                    setReceivedInvoiceDetails(null);
                    setReceivedGRVExpanded(false);
                    setReceivedGRVAssignments({});
                  }}>Close</Btn>
                </div>
              </>}
            </div>;
          })()}
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
      <Modal
        open={!!permanentDeleteRequest}
        onClose={() => setPermanentDeleteRequest(null)}
        title="Permanently delete archived invoice"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            This action cannot be undone. {permanentDeleteRequest?.ids.length > 1
              ? `${permanentDeleteRequest.ids.length} archived invoices will be permanently deleted.`
              : `Invoice ${permanentDeleteRequest?.invoices[0]?.number || "DRAFT"} will be permanently deleted.`}
          </p>
          {permanentDeleteRequest?.hasPaymentHistory && <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {permanentDeleteRequest.ids.length > 1
              ? "Deleting these invoices may also reverse the payments clients made for them."
              : "Deleting this invoice will also reverse the payment the client made for the invoice."}
          </p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Btn variant="outline" onClick={() => setPermanentDeleteRequest(null)}>Cancel</Btn>
            {permanentDeleteRequest?.hasPaymentHistory ? <>
              <Btn variant="danger" onClick={() => permanentlyDelete(false)} data-testid="delete-invoice-without-reversing-payment">
                Don&apos;t reverse {permanentDeleteRequest.ids.length > 1 ? "payments" : "payment"}
              </Btn>
              <Btn variant="danger" onClick={() => permanentlyDelete(true)} data-testid="delete-invoice-and-reverse-payment">
                Reverse {permanentDeleteRequest.ids.length > 1 ? "payments" : "payment"} &amp; delete
              </Btn>
            </> : <Btn variant="danger" onClick={() => permanentlyDelete(false)} data-testid="confirm-permanent-invoice-delete">
              Delete permanently
            </Btn>}
          </div>
        </div>
      </Modal>
      {pdfDownload && <div className="invoice-pdf-renderer" aria-hidden="true">
        <InvoiceDocument
          ref={pdfDocumentRef}
          inv={pdfDownload.invoice}
          totals={{
            subtotal: Number(pdfDownload.invoice.subtotal) || 0,
            tax: Number(pdfDownload.invoice.tax_amount) || 0,
            total: Number(pdfDownload.invoice.total) || 0,
            outstanding: Number(pdfDownload.invoice.outstanding) || 0,
          }}
          customer={pdfDownload.customer}
          settings={pdfDownload.settings}
          previousInvoices={pdfDownload.invoice.previous_invoices_pending || []}
          customerBalanceBeforeInvoice={Number(pdfDownload.invoice.customer_balance_before_invoice) || 0}
          showCustomerBalance={pdfDownload.invoice.include_previous_balance !== false
            && pdfDownload.invoice.customer_balance_before_invoice != null}
        />
      </div>}
    </div>
  );
}
