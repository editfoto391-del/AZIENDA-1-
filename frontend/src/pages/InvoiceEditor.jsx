import { useEffect, useState, useMemo, useRef } from "react";
import { InvoiceDocument } from "@/components/InvoiceDocument";
import { DeliveryNote } from "@/components/DeliveryNote";
import { elementToPdf, printElement } from "@/lib/pdf";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtMoney, fmtDate, fmtDateTime, today, newKey, STATUS_META, documentFilename } from "@/lib/format";
import { usesUnifiedPriceList } from "@/lib/company";
import { useAuth } from "@/context/AuthContext";
import { Card, Btn, Input, Select, Textarea, Badge, Modal } from "@/components/common";
import { Copy, Download, Save, Send, CreditCard, Plus, Trash2, ArrowLeft, Ban, Printer, AlertTriangle, Pencil, X, History, Eye, EyeOff, Archive } from "lucide-react";

const CATS = {
  1: ["Simple/Mix color", "Ribbon Black", "Ribbon Pink", "Candy", "Strong Boy", "Uncovered"],
  2: ["Simple/Mix color", "Ribbon Black", "Ribbon Pink", "Candy", "Strong Boy", "Uncovered Blue 16 Density"],
};
const UNIFIED_CATS = ["Simple/Mix color", "Ribbon Black", "Ribbon Pink"];
const RIBBON = ["Ribbon Black", "Ribbon Pink", "Candy"];
const priceCat = (zone, cat, unifiedPriceList) => {
  if (cat === "Simple/Mix color") return unifiedPriceList ? "Simple" : "Standard";
  return cat === "Candy" ? "Ribbon Black" : cat;
};
const manualOnly = (cat, size) => RIBBON.includes(cat) && size === "1370x150";
const isOpeningBalancePlaceholder = (item) => !item.category && !item.size && item.description?.trim().toLowerCase() === "opening balance";

const emptyItem = (category = "Simple/Mix color") => ({ qty: 1, category, size: "", description: "", unit_price: 0, price_override: false, tax: false, _needsConfig: false });

export default function InvoiceEditor() {
  const { user } = useAuth();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const { id } = useParams();
  const nav = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [prices, setPrices] = useState([]);
  const [settings, setSettings] = useState({});
  const [inv, setInv] = useState({
    customer_id: "", customer_name: "", date: today(), due_date: today(), zone: 1,
    payment_terms: "Due on Delivery", reference: "", notes: "", items: [emptyItem()],
    discount: 0, extra_charges: 0, tax_enabled: false, tax_rate: 15, status: "draft",
    amount_paid: 0, number: null,
  });
  const [payRecords, setPayRecords] = useState([]);
  const [payModal, setPayModal] = useState(null);
  const [nextNum, setNextNum] = useState("");
  const [pendingSave, setPendingSave] = useState(null);
  const [pendingStockSubmit, setPendingStockSubmit] = useState(null);
  const [downloadIssuedDraft, setDownloadIssuedDraft] = useState(false);
  const docRef = useRef(null);
  const saveLockRef = useRef(false);
  const pdfBusyRef = useRef(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sp, setSp] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [editAuthOpen, setEditAuthOpen] = useState(false);
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [editAuthorization, setEditAuthorization] = useState("");
  const [authorizingEdit, setAuthorizingEdit] = useState(false);
  const [compactPreview, setCompactPreview] = useState(false);
  const deliveryNoteRef = useRef(null);
  const locked = !!id && !editing;

  const prepareForEdit = (invoice) => invoice.opening_balance
    ? { ...invoice, opening_balance: false, reference: "", notes: "", items: [emptyItem()] }
    : invoice;

  useEffect(() => {
    Promise.all([api.get("/customers"), api.get("/prices"), api.get("/settings")]).then(([c, p, s]) => {
      setCustomers(c); setPrices(p); setSettings(s);
      if (!id) setInv((prev) => ({ ...prev, tax_enabled: s.tax_enabled, tax_rate: s.tax_rate }));
    });
    setEditing(false);
    if (id) api.get(`/invoices/${id}`).then((d) => {
      const loaded = { ...d, zone: unifiedPriceList ? 1 : d.zone, items: (d.items || []).map((item) => ({
        ...item,
        category: ["Standard", "Simple"].includes(item.category) ? "Simple/Mix color" : item.category,
      })) };
      setInv(loaded); setPayRecords(d.payment_records || []);
      if (sp.get("edit") && d.status !== "void") {
        setEditAuthOpen(true);
        setSp({}, { replace: true });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id && /^\d{4}-/.test(inv.date)) {
      api.get(`/invoices/next-number?year=${encodeURIComponent(inv.date.slice(0, 4))}`)
        .then((d) => setNextNum(d.number))
        .catch((error) => toast.error(apiError(error)));
    }
  }, [id, inv.date]);

  const startEdit = () => setEditAuthOpen(true);
  const authorizeEdit = async (event) => {
    event.preventDefault();
    if (!supervisorPassword || authorizingEdit) return;
    setAuthorizingEdit(true);
    try {
      const approval = await api.post(`/invoices/${id}/authorize-edit`, { password: supervisorPassword });
      setSnapshot(inv);
      setInv(prepareForEdit(inv));
      setEditAuthorization(approval.authorization_id);
      setEditing(true);
      setEditAuthOpen(false);
      setSupervisorPassword("");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setAuthorizingEdit(false);
    }
  };
  const cancelEdit = () => {
    setInv(snapshot);
    setEditing(false);
    setEditAuthorization("");
  };

  const categoriesFor = (zone) => {
    const defaults = unifiedPriceList ? UNIFIED_CATS : CATS[zone];
    const configured = prices
      .filter((p) => p.zone === zone && p.active && p.category)
      .map((p) => ["Standard", "Simple"].includes(p.category) ? "Simple/Mix color" : p.category);
    return [...new Set([...defaults, ...configured])];
  };

  const sizesFor = (zone, cat) => prices.filter((p) => p.zone === zone && p.category === priceCat(zone, cat, unifiedPriceList) && p.active).map((p) => p.size);

  const lookupPrice = (zone, cat, size) => {
    if (!unifiedPriceList && manualOnly(cat, size)) return { price: null, needsConfig: true };
    const p = prices.find((x) => x.zone === zone && x.category === priceCat(zone, cat, unifiedPriceList) && x.size === size && x.active);
    if (!p) return { price: null, needsConfig: false, missing: true };
    if (p.price == null || !p.confirmed) return { price: null, needsConfig: true };
    return { price: p.price, needsConfig: false };
  };

  const updateItem = (idx, patch) => {
    setInv((prev) => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], ...patch };
      return { ...prev, items };
    });
  };

  const onCatSize = (idx, patch) => {
    const it = { ...inv.items[idx], ...patch };
    patch.price_override = false;
    if (it.category && it.size) {
      const r = lookupPrice(inv.zone, it.category, it.size);
      patch.unit_price = r.price ?? 0;
      patch._needsConfig = r.needsConfig || r.missing;
    } else { patch.unit_price = 0; patch._needsConfig = false; }
    updateItem(idx, patch);
  };

  const repriceItems = (items, zone) => items.map((it) => {
    if (it.price_override) return it;
    const cats = categoriesFor(zone);
    const cat = cats.includes(it.category) ? it.category : cats[0];
    const r = lookupPrice(zone, cat, it.size);
    return { ...it, category: cat, unit_price: r.price ?? 0, _needsConfig: !!it.size && (r.needsConfig || r.missing) };
  });

  const confirmReprice = (items, next) => {
    const changes = items.map((it, i) => ({ it, n: next[i] })).filter(({ it, n }) => it.size && Number(it.unit_price) !== Number(n.unit_price));
    if (!changes.length) return true;
    const kept = items.filter((it) => it.price_override && it.size).length;
    return window.confirm(`Apply new zone prices?\n\n${changes.map(({ it, n }) => `${it.category} ${it.size}: ${fmtMoney(it.unit_price)} → ${n._needsConfig ? "needs confirmation" : fmtMoney(n.unit_price)}`).join("\n")}${kept ? `\n\n${kept} manual price(s) will be kept.` : ""}`);
  };

  const changeZone = (zone) => {
    const next = repriceItems(inv.items, zone);
    if (!confirmReprice(inv.items, next)) return;
    setInv({ ...inv, zone, items: next });
  };

  const selectCustomer = (cid) => {
    const c = customers.find((x) => x.id === cid);
    if (!c) { setInv((prev) => ({ ...prev, customer_id: "", customer_name: "" })); return; }
    const zone = unifiedPriceList ? 1 : c.default_zone;
    let items = inv.items;
    if (!unifiedPriceList && zone !== inv.zone) {
      const next = repriceItems(inv.items, zone);
      if (confirmReprice(inv.items, next)) items = next;
    }
    setInv({ ...inv, customer_id: cid, customer_name: c.name, payment_terms: c.payment_terms, zone: items === inv.items ? inv.zone : zone, items, destination: inv.destination || c.city || "" });
    if (!c.city) toast.info("This customer has no saved city. Please confirm the delivery destination.");
  };

  const setCustomerName = (name) => {
    const match = customers.find((customer) => customer.active && customer.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (match) {
      selectCustomer(match.id);
      return;
    }
    setInv((prev) => ({ ...prev, customer_id: "", customer_name: name, destination: "" }));
  };

  const totals = useMemo(() => {
    const subtotal = inv.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
    const taxed = Math.max(subtotal - Number(inv.discount || 0) + Number(inv.extra_charges || 0), 0);
    const tax = inv.tax_enabled ? taxed * (Number(inv.tax_rate) || 0) / 100 : 0;
    const total = taxed + tax;
    const outstanding = total - Number(inv.amount_paid || 0);
    return { subtotal, tax, total, outstanding };
  }, [inv]);
  const invoiceItems = (inv.items || []).filter((item) => !isOpeningBalancePlaceholder(item));
  const openingBalanceOnly = !!inv.opening_balance && invoiceItems.length === 0;

  const hasConfigIssue = inv.items.some((it) => it._needsConfig && it.size && !(it.price_override && Number(it.unit_price) > 0));
  const [busy, setBusy] = useState(false);

  const buildPayload = (status) => ({
    customer_id: inv.customer_id, customer_name: inv.customer_name, date: inv.date,
    due_date: inv.due_date, zone: inv.zone, payment_terms: inv.payment_terms,
    reference: inv.reference, notes: inv.notes, destination: inv.destination || "",
    items: inv.items.filter((it) => it.size || it.description).map((it) => ({
      qty: Number(it.qty) || 0, category: it.category, size: it.size, description: it.description,
      unit_price: Number(it.unit_price) || 0, price_override: it.price_override, tax: it.tax,
    })),
    opening_balance: !!inv.opening_balance,
    discount: Number(inv.discount) || 0, extra_charges: Number(inv.extra_charges) || 0,
    tax_enabled: inv.tax_enabled, tax_rate: Number(inv.tax_rate) || 0, status,
  });

  const validate = (status) => {
    if (!inv.customer_name.trim()) { toast.error("Enter or select a customer"); return false; }
    if (!inv.items.some((it) => it.size || it.description)) { toast.error("Add at least one item"); return false; }
    if (inv.items.some((it) => (Number(it.qty) || 0) <= 0 && (it.size || it.description))) { toast.error("Quantity must be positive"); return false; }
    if (status !== "draft" && hasConfigIssue) { toast.error("Some items require administrator confirmation. Enter a manual price before issuing."); return false; }
    return true;
  };

  const save = async (status, saveNewEntries = null, downloadAfterSave = false, deductStock = null) => {
    if (!validate(status) || busy || saveLockRef.current) return;
    if (status !== "draft" && deductStock === null) {
      setPendingStockSubmit({ action: "save", status, downloadAfterSave });
      return;
    }
    if (!id && saveNewEntries === null) {
      const knownCustomer = customers.some((customer) => customer.active && customer.name.trim().toLowerCase() === inv.customer_name.trim().toLowerCase());
      const newProducts = [...new Map(invoiceItems
        .filter((item) => item.category?.trim() && item.size?.trim())
        .filter((item) => !prices.some((price) => price.zone === inv.zone &&
          price.category === priceCat(inv.zone, item.category, unifiedPriceList) && price.size === item.size))
        .map((item) => [`${priceCat(inv.zone, item.category, unifiedPriceList)}|${item.size}`, item])).values()];
      if (!knownCustomer || newProducts.length) {
        setPendingSave({ status, newCustomer: !knownCustomer, newProducts, downloadAfterSave, deductStock });
        return;
      }
    }
    saveLockRef.current = true;
    setBusy(true);
    try {
      let customerId = inv.customer_id;
      if (saveNewEntries && !customerId) {
        const existingCustomer = customers.find((customer) => customer.name.trim().toLowerCase() === inv.customer_name.trim().toLowerCase());
        if (existingCustomer) customerId = existingCustomer.id;
        else if (inv.customer_name.trim()) {
          const createdCustomer = await api.post("/customers", {
            name: inv.customer_name.trim(),
            default_zone: inv.zone,
            payment_terms: inv.payment_terms,
            active: true,
          });
          customerId = createdCustomer.id;
          setCustomers((current) => [...current, createdCustomer]);
        }
      }
      if (saveNewEntries && pendingSave?.newProducts.length) {
        const savedPrices = await Promise.all(pendingSave.newProducts.map((item) => {
          const price = Number(item.unit_price);
          return api.post("/prices", {
            zone: unifiedPriceList ? 1 : inv.zone,
            category: priceCat(inv.zone, item.category, unifiedPriceList),
            size: item.size.trim(),
            price: price > 0 ? price : null,
            active: true,
            confirmed: price > 0,
          });
        }));
        if (savedPrices.length) setPrices((current) => [...current, ...savedPrices]);
      }
      const payload = { ...buildPayload(status), customer_id: customerId, customer_name: inv.customer_name.trim(), deduct_stock: !!deductStock };
      const res = id ? await api.put(`/invoices/${id}`, { ...payload, supervisor_authorization: editAuthorization }) : await api.post("/invoices", payload);
      const submitted = !id && status !== "draft";
      toast.success(submitted ? "INVOICE SUBMITTED" : status === "draft" ? "Saved as draft" : "Invoice saved");
      setPendingSave(null);
      nav(submitted && !downloadAfterSave ? "/invoices" : `/invoices/${res.id}${downloadAfterSave ? "?pdf=1" : ""}`);
      if (id) { setInv(res); setEditAuthorization(""); }
    } catch (e) { toast.error(apiError(e)); } finally { saveLockRef.current = false; setBusy(false); }
  };

  const saveEdit = async () => {
    if (!validate(inv.status === "draft" ? "draft" : "issued") || busy || saveLockRef.current) return;
    const reason = window.prompt("Reason for this change (optional):", "");
    if (reason === null) return;
    if (inv.status !== "draft") {
      setPendingStockSubmit({ action: "edit", reason });
      return;
    }
    await submitEdit(false, reason);
  };

  const submitEdit = async (deductStock, reason) => {
    if (busy || saveLockRef.current) return;
    saveLockRef.current = true;
    setBusy(true);
    try {
      const res = await api.put(`/invoices/${id}`, {
        ...buildPayload(inv.status === "draft" ? "draft" : "issued"),
        edit_reason: reason,
        deduct_stock: deductStock,
        supervisor_authorization: editAuthorization,
      });
      setInv(res); setPayRecords(res.payment_records || []); setEditing(false); setEditAuthorization("");
      toast.success("Invoice updated");
    } catch (e) { toast.error(apiError(e)); } finally { saveLockRef.current = false; setBusy(false); }
  };

  const issueExisting = () => setPendingStockSubmit({ action: "issue" });

  const chooseStockDeduction = async (deductStock) => {
    const pending = pendingStockSubmit;
    if (!pending) return;
    setPendingStockSubmit(null);
    if (pending.action === "save") {
      save(pending.status, null, pending.downloadAfterSave, deductStock);
      return;
    }
    if (pending.action === "edit") {
      submitEdit(deductStock, pending.reason);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post(`/invoices/${id}/issue`, { deduct_stock: deductStock });
      setInv(res);
      if (pending.action === "download") {
        setDownloadIssuedDraft(true);
        toast.success("Invoice issued");
      } else {
        toast.success("Invoice issued");
        nav("/invoices");
      }
    }
    catch (e) { toast.error(apiError(e)); }
    finally { setBusy(false); }
  };

  const voidInvoice = async () => {
    const reason = window.prompt("Reason for voiding this invoice (required):");
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required to void an invoice");
    try { const res = await api.post(`/invoices/${id}/void`, { reason }); setInv({ ...inv, status: res.status, void_reason: reason }); toast.success("Invoice voided"); }
    catch (e) { toast.error(apiError(e)); }
  };

  const archiveDraft = async () => {
    if (!window.confirm("Archive this draft invoice? It will be retained and can be restored from the invoice list.")) return;
    try {
      await api.del(`/invoices/${id}`);
      toast.success("Draft archived");
      nav("/invoices");
    } catch (e) { toast.error(apiError(e)); }
  };

  const reloadInv = async () => { const d = await api.get(`/invoices/${id}`); setInv(d); setPayRecords(d.payment_records || []); };

  const recordPayment = async () => {
    if (busy) return;
    if (!(Number(payModal.amount) > 0)) return toast.error("Amount must be greater than 0");
    setBusy(true);
    try {
      await api.post(`/invoices/${id}/payments`, { ...payModal, amount: Number(payModal.amount) });
      await reloadInv(); setPayModal(null);
      toast.success("Payment recorded");
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const reversePayment = async (p) => {
    const reason = window.prompt(`Reverse payment of ${fmtMoney(p.amount)}? Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    try { await api.post(`/payments/${p.id}/reverse`, { reason }); await reloadInv(); toast.success("Payment reversed"); }
    catch (e) { toast.error(apiError(e)); }
  };

  const invoiceText = () => {
    const L = [];
    L.push(settings.company_name || "SUPER IQ-FOAM");
    L.push(`INVOICE: ${inv.number || "DRAFT"}`);
    L.push("");
    L.push(`Customer: ${inv.customer_name || "-"}`);
    L.push(`Invoice Date: ${fmtDate(inv.date)}`);
    L.push(`Due Date: ${fmtDate(inv.due_date)}`);
    if (!unifiedPriceList) L.push(`Price Zone: Zone ${inv.zone}`);
    L.push(`Payment Terms: ${inv.payment_terms}`);
    if (inv.destination) L.push(`Delivery To: ${inv.destination}`);
    if (inv.reference && !inv.opening_balance) L.push(`Reference: ${inv.reference}`);
    L.push("");
    const textItems = invoiceItems.filter((it) => it.size || it.description);
    if (textItems.length) {
      L.push("ITEMS");
      L.push("--------------------------------");
      textItems.forEach((it) => {
        L.push(`Qty: ${it.qty}`);
        L.push(`Category: ${it.category}`);
        L.push(`Size: ${it.size || it.description}`);
        L.push(`Unit Price: ${fmtMoney(it.unit_price)}`);
        L.push(`Line Total: ${fmtMoney((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}`);
        L.push("--------------------------------");
      });
    }
    L.push(`Subtotal: ${fmtMoney(totals.subtotal)}`);
    if (Number(inv.discount)) L.push(`Discount: ${fmtMoney(inv.discount)}`);
    if (Number(inv.extra_charges)) L.push(`Added: ${fmtMoney(inv.extra_charges)}`);
    if (inv.tax_enabled) L.push(`Tax (${inv.tax_rate}%): ${fmtMoney(totals.tax)}`);
    L.push(`Total: ${fmtMoney(totals.total)}`);
    L.push(`Amount Paid: ${fmtMoney(inv.amount_paid)}`);
    L.push(`Outstanding Balance: ${fmtMoney(totals.outstanding)}`);
    if (inv.notes && !inv.opening_balance) { L.push(""); L.push(`Notes: ${inv.notes}`); }
    if (settings.telephone || settings.email) {
      L.push(""); L.push([settings.telephone, settings.email].filter(Boolean).join(" | "));
    }
    return L.join("\n");
  };

  const copyInvoice = async () => {
    const text = invoiceText();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast.success("Invoice copied successfully");
      } else throw new Error("fallback");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); toast.success("Invoice copied successfully"); }
      catch { window.prompt("Copy the invoice text below:", text); }
      document.body.removeChild(ta);
    }
  };

  const runPdfDownload = async (element, filename, successMessage, errorLabel, returnToInvoices = false) => {
    if (pdfBusyRef.current) return;
    pdfBusyRef.current = true;
    setPdfBusy(true);
    try {
      await elementToPdf(element, filename);
      toast.success(successMessage);
      if (returnToInvoices) nav("/invoices");
    } catch (error) {
      toast.error(`${errorLabel}: ${error.message}`);
    } finally {
      pdfBusyRef.current = false;
      setPdfBusy(false);
    }
  };
  const downloadPDF = async () => {
    if (!id) {
      await save("issued", null, true);
      return;
    }
    if (inv.status === "draft") {
      if (busy) return;
      setPendingStockSubmit({ action: "download" });
      return;
    }
    return runPdfDownload(
      docRef.current,
      `${documentFilename("Invoice", inv.customer_name || "Customer", inv.number || "Draft")}.pdf`,
      "Invoice PDF downloaded",
      "Could not generate the invoice PDF",
      true,
    );
  };
  const custObj = customers.find((c) => c.id === inv.customer_id) || {};
  const invoiceDeliveryNote = {
    reference: inv.number || "DRAFT",
    expected_ship_date: inv.date,
    customer_name: inv.customer_name,
    customer_address: custObj.address || "",
    customer_phone: custObj.phone || "",
    customer_email: custObj.email || "",
    destination: inv.destination || custObj.city || "",
    vehicle_id: "",
    notes: inv.notes || "",
    opening_balance: !!inv.opening_balance,
    items: inv.opening_balance ? [] : (inv.items || []).filter((item) => item.size || item.description).map((item) => ({
      qty: item.qty,
      category: item.category || "",
      description: item.description || "",
      size: item.size || "",
    })),
  };
  const downloadDeliveryNote = () => runPdfDownload(
    deliveryNoteRef.current,
    `${documentFilename("Delivery-note", inv.customer_name || "Customer", inv.number || "Draft")}.pdf`,
    "Delivery note PDF downloaded",
    "Could not generate the delivery note PDF",
  );
  const createAndDownload = async () => {
    if (id) return downloadPDF();
    await downloadPDF();
  };
  useEffect(() => {
    if (id && inv.id === id && customers.length && sp.get("pdf") === "1") {
      setSp({}, { replace: true });
      setTimeout(downloadPDF, 500);
    }
    if (id && inv.id === id && customers.length && sp.get("delivery-note") === "1") {
      setSp({}, { replace: true });
      setTimeout(downloadDeliveryNote, 500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, inv.id, customers.length, sp]);
  useEffect(() => {
    if (!downloadIssuedDraft || inv.status !== "issued") return;
    const timeout = window.setTimeout(() => {
      setDownloadIssuedDraft(false);
      runPdfDownload(
        docRef.current,
        `${documentFilename("Invoice", inv.customer_name || "Customer", inv.number || "Draft")}.pdf`,
        "Invoice PDF downloaded",
        "Could not generate the invoice PDF",
        true,
      );
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [downloadIssuedDraft, inv]);
  const printInvoice = () => { if (!printElement(docRef.current, inv.number || "Invoice")) toast.error("Allow pop-ups to print"); };

  const st = STATUS_META[inv.status] || STATUS_META.draft;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 no-print">
        <button onClick={() => nav("/invoices")} className="flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-800">
          <ArrowLeft size={16} /> Back to Invoices
        </button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Btn variant="outline" onClick={downloadDeliveryNote} disabled={pdfBusy || !inv.customer_name || !invoiceDeliveryNote.items.length} data-testid="download-delivery-note-btn">
            <Download size={15} /> {pdfBusy ? "Generating PDF..." : "Download Delivery Note PDF"}
          </Btn>
          <button onClick={() => setCompactPreview((v) => !v)} className="inline-flex items-center gap-1.5 h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:border-primary hover:text-primary transition-colors" data-testid="toggle-invoice-preview-mode">
            {compactPreview ? <Eye size={15} /> : <EyeOff size={15} />}
            {compactPreview ? "Show sections" : "Hide sections"}
          </button>
          <Badge cls={st.cls}>{st.label}</Badge>
          {inv.opening_balance && <Badge cls="bg-violet-50 text-violet-700 border-violet-200">Opening Balance</Badge>}
          {locked && inv.status !== "void" && (
            <button onClick={startEdit} data-testid="edit-invoice-btn"
              className="inline-flex items-center gap-1.5 h-9 rounded-lg border border-primary/50 bg-white px-3 text-sm font-semibold text-primary hover:bg-blue-50 transition-colors">
              <Pencil size={15} /> Edit
            </button>)}
          <button onClick={copyInvoice} title="Copy invoice to clipboard" data-testid="copy-invoice-btn"
            className="h-9 w-9 flex items-center justify-center rounded-lg border border-border bg-white text-slate-600 hover:text-primary hover:border-primary">
            <Copy size={17} />
          </button>
        </div>
      </div>

      {editing && (
        <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5" data-testid="editing-bar">
          <span className="text-sm font-semibold text-amber-800">Editing — unsaved changes</span>
          <div className="flex gap-2">
            <Btn variant="outline" onClick={cancelEdit} data-testid="cancel-edit-btn"><X size={15} /> Cancel</Btn>
            <Btn disabled={busy} onClick={saveEdit} data-testid="save-edit-btn"><Save size={15} /> {busy ? "Saving..." : "Save changes"}</Btn>
          </div>
        </div>
      )}
      {editing && snapshot?.opening_balance && (
        <div className="no-print mb-5 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800" data-testid="opening-balance-conversion-warning">
          Saving this change will replace the imported opening balance with the products and prices entered below.
        </div>
      )}

      <div className={`grid gap-6 ${compactPreview ? "grid-cols-1 xl:grid-cols-[1fr_420px]" : "grid-cols-1 xl:grid-cols-5"}`}>
        {!compactPreview && (
          <div className="xl:col-span-3 space-y-6 min-w-0">
          <fieldset disabled={locked} className="space-y-6 min-w-0" data-testid="invoice-form">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card className="p-5"><h3 className="font-bold text-slate-800 font-display mb-4 flex items-center gap-2">1. Customer Information</h3>
                <div className="space-y-4"><Input label="Customer *" list="invoice-customer-options" value={inv.customer_name || ""} onChange={(e) => setCustomerName(e.target.value)} data-testid="invoice-customer-select" />
                <datalist id="invoice-customer-options">{customers.filter((customer) => customer.active).map((customer) => <option key={customer.id} value={customer.name} />)}</datalist>
                <div className={`grid ${unifiedPriceList ? "grid-cols-1" : "grid-cols-2"} gap-3`}>{!unifiedPriceList && <Select label="Price Zone" value={inv.zone} onChange={(e) => changeZone(Number(e.target.value))} data-testid="invoice-zone-select">
                  <option value={1}>Zone 1</option><option value={2}>Zone 2</option>
                </Select>}<Select label="Payment Terms" value={inv.payment_terms} onChange={(e) => setInv({ ...inv, payment_terms: e.target.value })}>
                  {(settings.payment_terms || ["Due on Delivery", "7 Days", "30 Days"]).map((t) => <option key={t}>{t}</option>)}
                </Select></div><Input label="Delivery Destination" value={inv.destination || ""} onChange={(e) => setInv({ ...inv, destination: e.target.value })} data-testid="invoice-destination-input" /></div></Card>
              <Card className="p-5"><div className="flex items-center justify-between mb-4"><h3 className="font-bold text-slate-800 font-display">2. Invoice Details</h3><span className="font-mono text-sm font-bold text-primary">{inv.number || nextNum || "DRAFT"}</span></div>
                <div className="space-y-4"><div className="grid grid-cols-2 gap-3"><Input label="Invoice Date" type="date" value={inv.date} onChange={(e) => setInv({ ...inv, date: e.target.value })} /><Input label="Due Date" type="date" value={inv.due_date} onChange={(e) => setInv({ ...inv, due_date: e.target.value })} /></div><Input label="Reference (optional)" value={inv.reference} onChange={(e) => setInv({ ...inv, reference: e.target.value })} />
                <Textarea label="Notes (optional)" rows={2} value={inv.notes || ""} onChange={(e) => setInv({ ...inv, notes: e.target.value })} placeholder="Additional notes..." /></div></Card>
            </div>

            {(!openingBalanceOnly || editing) && <Card className="p-5">
              <h3 className="font-bold text-slate-800 mb-4 font-display">3. Products</h3>
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full text-sm min-w-[720px]">
                  <thead><tr className="text-left text-xs text-slate-400 border-b border-border">
                    <th className="pb-2 font-semibold w-16">Qty</th><th className="pb-2 font-semibold">Product / Category</th><th className="pb-2 font-semibold">Size / Unit</th><th className="pb-2 font-semibold w-32">Unit Price (R)</th><th className="pb-2 font-semibold text-right w-28">Line Total</th><th className="w-10"></th>
                  </tr></thead>
                  <tbody>{invoiceItems.map((it, idx) => (
                    <tr key={idx} className="border-b border-border/50" data-testid={`item-row-${idx}`}>
                      <td className="py-2 pr-2">
                        <input type="number" min="0" value={it.qty} onChange={(e) => updateItem(idx, { qty: e.target.value })} data-testid={`item-qty-${idx}`}
                          className="w-16 rounded border border-input px-2 py-1.5 text-sm" />
                      </td>
                      <td className="pr-2" colSpan={!it.category && it.description ? 2 : 1}>
                        {!it.category && it.description ? (
                          <input value={it.description} onChange={(e) => updateItem(idx, { description: e.target.value })} data-testid={`item-desc-${idx}`}
                            className="w-full rounded border border-input px-2 py-1.5 text-sm" />
                        ) : (
                        <>
                        <input list={`invoice-category-options-${idx}`} value={it.category} onChange={(e) => onCatSize(idx, { category: e.target.value, size: "" })} data-testid={`item-cat-${idx}`}
                          className="w-full rounded border border-input px-2 py-1.5 text-sm min-w-[130px]" />
                        <datalist id={`invoice-category-options-${idx}`}>{categoriesFor(inv.zone).map((category) => <option key={category} value={category} />)}</datalist>
                        </>)}
                      </td>
                      {!(!it.category && it.description) && <td className="pr-2">
                        <input list={`invoice-size-options-${idx}`} value={it.size} onChange={(e) => onCatSize(idx, { size: e.target.value })} data-testid={`item-size-${idx}`}
                          className="w-full rounded border border-input px-2 py-1.5 text-sm min-w-[110px]" />
                        <datalist id={`invoice-size-options-${idx}`}>{sizesFor(inv.zone, it.category).map((size) => <option key={size} value={size} />)}</datalist>
                      </td>}
                      <td className="pr-2">
                        <div className="flex items-center gap-1">
                          <input type="number" step="0.01" value={it.unit_price}
                            onChange={(e) => updateItem(idx, { unit_price: e.target.value, price_override: true })} data-testid={`item-price-${idx}`}
                            className={`w-24 rounded border px-2 py-1.5 text-sm font-mono ${it._needsConfig && it.size && !(it.price_override && Number(it.unit_price) > 0) ? "border-red-400 bg-red-50" : it.price_override ? "border-amber-400 bg-amber-50" : "border-input"}`} />
                          {it.price_override && <span title="Manual override" className="text-[10px] font-bold text-amber-600">M</span>}
                        </div>
                        {it._needsConfig && it.size && <span className="text-[10px] text-red-600 flex items-center gap-0.5 mt-0.5" data-testid={`item-needs-config-${idx}`}><AlertTriangle size={10} /> {manualOnly(it.category, it.size) ? "Manual price required" : "Requires administrator confirmation"}</span>}
                      </td>
                      <td className="text-right font-mono text-slate-700">{fmtMoney((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
                      <td className="text-right">
                        <button onClick={() => setInv({ ...inv, items: inv.items.filter((_, i) => i !== idx) })} className="text-slate-300 hover:text-red-600 p-1" data-testid={`item-delete-${idx}`}><Trash2 size={16} /></button>
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
              <Btn variant="outline" className="mt-4" onClick={() => setInv({ ...inv, items: [...inv.items, emptyItem()] })} data-testid="add-item-btn"><Plus size={16} /> Add Product</Btn>
            </Card>}
          </fieldset>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              <div className="space-y-6">

            <Card className="p-5 space-y-2 no-print">
              <h3 className="font-bold text-slate-800 mb-3 font-display">4. Payment Information</h3>
              {inv.status === "void" ? <p className="text-sm text-slate-400" data-testid="void-reason">This invoice is voided.{inv.void_reason ? ` Reason: ${inv.void_reason}` : ""}</p> : (
                <div className="grid grid-cols-2 gap-2">
                  {!id && <Btn variant="outline" disabled={busy} onClick={() => save("draft")} data-testid="save-draft-btn"><Save size={15} /> {busy ? "Saving…" : "Draft"}</Btn>}
                  {!id && <Btn disabled={busy} onClick={() => save("issued")} data-testid="issue-invoice-btn"><Send size={15} /> {busy ? "Saving…" : "Issue"}</Btn>}
                  <Btn variant="outline" onClick={copyInvoice} data-testid="copy-btn-2"><Copy size={15} /> Copy</Btn>
                  <Btn variant="outline" onClick={downloadPDF} disabled={busy || pdfBusy} data-testid="download-pdf-btn"><Download size={15} /> {busy ? "Issuing..." : pdfBusy ? "Generating PDF..." : "Download PDF"}</Btn>
                  <Btn variant="outline" onClick={printInvoice} data-testid="print-invoice-btn"><Printer size={15} /> Print</Btn>
                  {id && inv.status !== "draft" && totals.outstanding > 0 && !editing && (
                    <Btn variant="success" onClick={() => setPayModal({ amount: totals.outstanding.toFixed(2), method: "Cash", date: today(), reference: "", notes: "", idempotency_key: newKey() })} data-testid="record-payment-btn"><CreditCard size={15} /> Pay</Btn>
                  )}
                  {id && inv.status === "draft" && !editing && <Btn variant="subtle" onClick={issueExisting} data-testid="issue-existing-btn"><Send size={15} /> Issue</Btn>}
                  {(user?.is_admin || user?.role === "admin" || user?.is_owner) && id && inv.status === "draft" && !inv.number && !editing && <Btn variant="ghost" className="col-span-2 text-amber-700" onClick={archiveDraft} data-testid="archive-draft-btn"><Archive size={15} /> Archive Draft</Btn>}
                  {id && inv.number && <Btn variant="ghost" className="col-span-2 text-red-600" onClick={voidInvoice} data-testid="void-invoice-btn"><Ban size={15} /> Void Invoice</Btn>}
                </div>
              )}
            </Card>

            {payRecords.length > 0 && (
              <Card className="p-5 no-print">
                <h3 className="font-bold text-slate-800 mb-3 font-display">Payment History</h3>
                <div className="space-y-2">{payRecords.map((p) => (
                  <div key={p.id} className={`flex items-center justify-between gap-2 text-sm border border-border rounded-lg px-3 py-2 ${p.reversed ? "opacity-60" : ""}`} data-testid={`payment-row-${p.id}`}>
                    <span className="text-slate-500">{fmtDate(p.date)} · {p.method}{p.reversed && <span className="ml-1 text-red-600 font-semibold">Reversed</span>}</span>
                    <span className={`font-mono font-semibold ${p.reversed ? "line-through text-slate-400" : "text-emerald-600"}`}>{fmtMoney(p.amount)}</span>
                    {!p.reversed && <button onClick={() => reversePayment(p)} className="text-xs text-red-500 hover:underline" data-testid={`reverse-payment-${p.id}`}>Reverse</button>}
                  </div>))}</div>
              </Card>
            )}

            {(inv.audit || []).some((a) => a.action === "edited" && a.changes) && (
              <Card className="p-5 no-print" data-testid="change-history">
                <h3 className="font-bold text-slate-800 mb-3 font-display flex items-center gap-2"><History size={16} /> Change History</h3>
                <ol className="relative border-l border-border ml-1.5 space-y-4">
                  {[...inv.audit].reverse().filter((a) => a.action === "edited" && a.changes).map((a, i) => (
                    <li key={i} className="ml-4" data-testid={`change-entry-${i}`}>
                      <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-white bg-primary" />
                      <p className="text-xs text-slate-400">{fmtDateTime(a.at)}{a.reason ? <span className="text-slate-600"> · {a.reason}</span> : ""}</p>
                      {a.changes.length === 0 ? <p className="text-xs text-slate-400">No field changes</p> : a.changes.map((c, k) => (
                        <p key={k} className="text-xs text-slate-600 mt-0.5 break-words"><span className="font-semibold">{c.field.replace("_", " ")}:</span> <span className="line-through text-slate-400">{String(c.old ?? "—")}</span> → {String(c.new ?? "—")}</p>
                      ))}
                    </li>))}
                </ol>
              </Card>
            )}
          </div>
              
            <Card className="p-5">
              <h3 className="font-bold text-slate-800 mb-4 font-display">5. Invoice Summary</h3>
              <fieldset disabled={locked} className="space-y-3 text-sm min-w-0">
                <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-mono font-semibold">{fmtMoney(totals.subtotal)}</span></div>
                <div className="flex justify-between items-center"><span className="text-slate-500">Discount</span>
                  <input type="number" step="0.01" value={inv.discount} onChange={(e) => setInv({ ...inv, discount: e.target.value })} data-testid="discount-input" className="w-24 rounded border border-input px-2 py-1 text-sm font-mono text-right" /></div>
                <div className="flex justify-between items-center"><span className="text-slate-500">Added</span>
                  <input type="number" step="0.01" value={inv.extra_charges} onChange={(e) => setInv({ ...inv, extra_charges: e.target.value })} className="w-24 rounded border border-input px-2 py-1 text-sm font-mono text-right" /></div>
                <label className="flex items-center justify-between"><span className="text-slate-500">Apply Tax {inv.tax_enabled ? `(${inv.tax_rate}%)` : ""}</span>
                  <input type="checkbox" checked={inv.tax_enabled} onChange={(e) => setInv({ ...inv, tax_enabled: e.target.checked })} /></label>
                {inv.tax_enabled && <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-mono">{fmtMoney(totals.tax)}</span></div>}
                <div className="flex justify-between border-t border-border pt-3 text-base"><span className="font-bold text-slate-800">Total</span><span className="font-mono font-bold text-slate-900" data-testid="invoice-total">{fmtMoney(totals.total)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Amount Paid</span><span className="font-mono text-emerald-600">{fmtMoney(inv.amount_paid)}</span></div>
                <div className="flex justify-between"><span className="font-semibold text-slate-700">Outstanding</span><span className="font-mono font-bold text-red-600" data-testid="invoice-outstanding">{fmtMoney(totals.outstanding)}</span></div>
              </fieldset>
            </Card>
            </div>
            <div className="no-print flex flex-wrap justify-between gap-3">
              <Btn variant="outline" onClick={() => (editing ? cancelEdit() : nav("/invoices"))} data-testid="bottom-cancel-btn">Cancel</Btn>
              <div className="flex flex-wrap gap-2">
                {!id && <Btn variant="outline" disabled={busy} onClick={() => save("draft")} data-testid="bottom-save-draft-btn"><Save size={15} /> {busy ? "Saving…" : "Save Draft"}</Btn>}
                <Btn variant="outline" onClick={() => document.querySelector('[data-testid="invoice-preview"]')?.scrollIntoView({ behavior: "smooth" })} data-testid="bottom-preview-btn">Preview Invoice</Btn>
                <Btn disabled={busy || pdfBusy} onClick={createAndDownload} data-testid="create-download-pdf-btn"><Download size={15} /> {pdfBusy ? "Generating PDF..." : id ? "Download PDF" : "Create & Download PDF"}</Btn>
              </div>
            </div>
          </div>
        )}
        <div className={compactPreview ? "xl:col-start-2 xl:row-start-1 min-w-0" : "xl:col-span-2 min-w-0"}>
          <div className="xl:sticky xl:top-20 space-y-3 no-print" data-testid="invoice-preview">
            <div className="grid grid-cols-2 rounded-lg bg-white border border-border p-1">
              <button className="rounded-md bg-primary text-white py-2 text-sm font-semibold" data-testid="tab-preview">Invoice Preview</button>
              <button onClick={downloadPDF} disabled={busy || pdfBusy} className="rounded-md py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50" data-testid="tab-pdf">{busy ? "Issuing..." : pdfBusy ? "Generating PDF..." : "Download PDF"}</button>
            </div>
            <Card className="p-3 overflow-hidden"><FitPreview>
              <InvoiceDocument inv={inv} totals={totals} settings={settings} customer={custObj} />
            </FitPreview></Card>
          </div>
          <div style={{ position: "fixed", left: -10000, top: 0 }} aria-hidden="true"><InvoiceDocument ref={docRef} inv={inv} totals={totals} settings={settings} customer={custObj} /></div>
          <div style={{ position: "fixed", left: -10000, top: 0 }} aria-hidden="true">
            <DeliveryNote ref={deliveryNoteRef} order={invoiceDeliveryNote} settings={settings} />
          </div>
        </div>
      </div>

      <Modal open={!!payModal} onClose={() => setPayModal(null)} title="Record Payment">
        {payModal && (
          <div className="space-y-4">
            <Input label="Amount (R)" type="number" step="0.01" value={payModal.amount} onChange={(e) => setPayModal({ ...payModal, amount: e.target.value })} data-testid="payment-amount-input" />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Method" value={payModal.method} onChange={(e) => setPayModal({ ...payModal, method: e.target.value })}>
                {(settings.payment_methods || ["Cash", "Bank Transfer"]).map((m) => <option key={m}>{m}</option>)}
              </Select>
              <Input label="Date" type="date" value={payModal.date} onChange={(e) => setPayModal({ ...payModal, date: e.target.value })} />
            </div>
            <Input label="Reference (optional)" value={payModal.reference} onChange={(e) => setPayModal({ ...payModal, reference: e.target.value })} />
            <Textarea label="Notes (optional)" rows={2} value={payModal.notes} onChange={(e) => setPayModal({ ...payModal, notes: e.target.value })} />
            <p className="text-xs text-slate-400">Outstanding: {fmtMoney(totals.outstanding)}. Only confirmed payments count as received.</p>
            <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setPayModal(null)}>Cancel</Btn><Btn variant="success" disabled={busy} onClick={recordPayment} data-testid="confirm-payment-btn">{busy ? "Saving..." : "Confirm Payment"}</Btn></div>
          </div>
        )}
      </Modal>
      <Modal open={editAuthOpen} onClose={() => { setEditAuthOpen(false); setSupervisorPassword(""); }} title="Supervisor approval required">
        <form onSubmit={authorizeEdit} className="space-y-4" data-testid="invoice-edit-authorization-form">
          <p className="text-sm text-slate-600">Enter the supervisor password to edit this invoice. This approval is required for every user role.</p>
          <Input label="Supervisor password" type="password" autoComplete="current-password" autoFocus required value={supervisorPassword} onChange={(event) => setSupervisorPassword(event.target.value)} data-testid="supervisor-password-input" />
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => { setEditAuthOpen(false); setSupervisorPassword(""); }}>Cancel</Btn>
            <Btn type="submit" disabled={authorizingEdit} data-testid="authorize-invoice-edit-btn">{authorizingEdit ? "Checking..." : "Continue to edit"}</Btn>
          </div>
        </form>
      </Modal>
      <Modal open={!!pendingSave} onClose={() => setPendingSave(null)} title="Save new customer or products?">
        {pendingSave && <div className="space-y-4">
          <p className="text-sm text-slate-600">It seems like you've added new information that does not exist in your lists. Do you want to save it?</p>
          {pendingSave.newCustomer && <p className="text-sm"><span className="font-semibold">New customer:</span> {inv.customer_name}</p>}
          {pendingSave.newProducts.length > 0 && <ul className="list-inside list-disc text-sm text-slate-700">
            {pendingSave.newProducts.map((item) => <li key={`${item.category}-${item.size}`}>{item.category} · {item.size} · {fmtMoney(item.unit_price)}</li>)}
          </ul>}
          <p className="text-xs text-slate-500">If you choose not to save, the customer name and product details will still appear on this invoice only.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Btn variant="outline" disabled={busy} onClick={() => { const { status, downloadAfterSave, deductStock } = pendingSave; setPendingSave(null); save(status, false, downloadAfterSave, deductStock); }} data-testid="invoice-dont-save-new-entry">Don't save it</Btn>
            <Btn disabled={busy} onClick={() => save(pendingSave.status, true, pendingSave.downloadAfterSave, pendingSave.deductStock)} data-testid="invoice-save-new-entry">Save it</Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={!!pendingStockSubmit} onClose={() => setPendingStockSubmit(null)}
        title={pendingStockSubmit?.action === "edit" ? "Update stock for edited invoice?" : "Deduct invoice items from stock?"}>
        {pendingStockSubmit && <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {pendingStockSubmit.action === "edit"
              ? "Do you want to update stock to match the edited invoice? Added or removed quantities will be reconciled."
              : "Do you want to subtract the quantities on this invoice from finished stock?"}
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {invoiceItems.map((item, index) => (
              <div key={`${item.category}-${item.size}-${index}`} className="flex justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-slate-700">{[item.category, item.size || item.description].filter(Boolean).join(" · ") || "Invoice item"}</span>
                <span className="shrink-0 font-mono font-semibold">× {item.qty}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {pendingStockSubmit.action === "edit"
              ? "Choosing no saves the invoice but leaves stock unchanged. If additional stock is insufficient, the edit will not be saved."
              : "Choosing no will submit the invoice without changing stock. If stock is insufficient, the invoice will not be issued."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Btn variant="outline" disabled={busy} onClick={() => chooseStockDeduction(false)} data-testid="invoice-submit-without-stock">No, keep stock unchanged</Btn>
            <Btn disabled={busy} onClick={() => chooseStockDeduction(true)} data-testid="invoice-submit-deduct-stock">
              {pendingStockSubmit.action === "edit" ? "Yes, update stock" : "Yes, deduct from stock"}
            </Btn>
          </div>
        </div>}
      </Modal>
    </div>
  );
}

function FitPreview({ children }) {
  const box = useRef(null);
  const [zoom, setZoom] = useState(0.6);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setZoom(Math.min(1, e.contentRect.width / 794)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={box} data-testid="invoice-preview-fit"><div style={{ zoom }}>{children}</div></div>;
}
