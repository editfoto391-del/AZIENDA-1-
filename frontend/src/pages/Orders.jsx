import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtMoney, documentFilename } from "@/lib/format";
import { Card, Btn, Input, Select, Textarea, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { ClipboardList, Plus, Trash2, Pencil, ArrowRight, Eye, FileText, Printer, Download, Search, RotateCcw, MoreHorizontal, Factory } from "lucide-react";
import { useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { DeliveryNote, orderLines } from "@/components/DeliveryNote";
import SmartProductionPlanner from "@/components/SmartProductionPlanner";
import { elementToPdf, printElement } from "@/lib/pdf";
import BarcodeScanner from "@/components/BarcodeScanner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STATUSES = ["To Send", "Preparing", "Assigned", "Dispatched", "Delivered", "Cancelled"];
const statusLabel = (status) => `${status}?`;
const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const S_META = {
  "To Send": "bg-slate-100 text-slate-700 border-slate-200", Preparing: "bg-indigo-50 text-indigo-700 border-indigo-200",
  Assigned: "bg-blue-50 text-blue-700 border-blue-200", Dispatched: "bg-amber-50 text-amber-700 border-amber-200",
  Delivered: "bg-emerald-50 text-emerald-700 border-emerald-200", Cancelled: "bg-slate-100 text-slate-400 border-slate-200",
};
const P_META = {
  Low: "bg-slate-100 text-slate-500 border-slate-200", Normal: "bg-blue-50 text-blue-700 border-blue-200",
  High: "bg-orange-50 text-orange-700 border-orange-200", Urgent: "bg-red-50 text-red-700 border-red-200",
};
const blank = () => ({ customer_id: "", customer_name: "", customer_address: "", customer_phone: "", customer_email: "", invoice_id: "", invoice_number: "", destination: "", products: "", items: [{ qty: "", category: "", size: "" }], priority: "Normal", status: "To Send", expected_ship_date: "", vehicle_id: "", notes: "" });
const WIDTHS = ["760", "910", "1070", "1370"];
const STANDARD_SIZES = WIDTHS.flatMap((width) => ["50", "75", "100", "120", "150"].map((height) => `${width}x${height}`));
const RIBBON_SIZES = WIDTHS.flatMap((width) => ["100", "120", "150"].map((height) => `${width}x${height}`));
const SIZE_CATALOG = {
  simple: STANDARD_SIZES,
  standard: STANDARD_SIZES,
  "simple/mix color": STANDARD_SIZES,
  "ribbon black": RIBBON_SIZES,
  "ribbon pink": RIBBON_SIZES,
  ribbon: RIBBON_SIZES,
  candy: ["760x100", ...RIBBON_SIZES.filter((size) => size !== "760x120" && size !== "760x150"), "910x125"],
  "strong boy": WIDTHS.map((width) => `${width}x125`),
  uncovered: ["910x100", "1070x100", "1370x100"],
  "uncovered blue 16 density": ["910x100", "1070x100"],
};
const priceCategoriesForProduct = (product) => {
  const normalized = String(product || "").trim().toLowerCase();
  if (["simple", "standard", "simple/mix color"].includes(normalized)) return ["Simple", "Standard"];
  if (normalized === "candy" || normalized === "black") return ["Candy", "Ribbon Black"];
  if (normalized === "ribbon") return ["Ribbon", "Ribbon Black", "Ribbon Pink"];
  return [product];
};

function OrderRowActions({ order, onView, onNote, onEdit, onAdvance, onCancel, onPurge, mobile = false }) {
  const nextStatus = STATUSES[STATUSES.indexOf(order.status) + 1];
  const canAdvance = order.status !== "Delivered" && order.status !== "Cancelled";
  const iconButtonClass = "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  const moreButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${iconButtonClass} ${mobile ? "h-10 w-10 shrink-0" : ""}`}
          aria-label={`More actions for order ${order.reference}`}
          title="More actions"
          data-testid={`${mobile ? "more-order-mobile" : "more-order"}-${order.id}`}
        >
          <MoreHorizontal size={17} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          onSelect={onCancel}
          className="text-red-700 focus:text-red-700"
          data-testid={`${mobile ? "delete-order-mobile" : "delete-order"}-${order.id}`}
        >
          <Trash2 size={15} /> Cancel order
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onPurge}
          className="text-red-700 focus:text-red-700"
          data-testid={`${mobile ? "purge-order-mobile" : "purge-order"}-${order.id}`}
        >
          <Trash2 size={15} /> Delete permanently
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (mobile) {
    return (
      <div className="mt-3 space-y-2 border-t border-border pt-3">
        <div className="grid grid-cols-3 gap-2">
          <Btn variant="outline" className="w-full px-2 py-2" onClick={onView} data-testid={`view-order-mobile-${order.id}`}><Eye size={16} /> View</Btn>
          <Btn variant="outline" className="w-full px-2 py-2" onClick={onNote} data-testid={`note-order-mobile-${order.id}`}><FileText size={16} /> Note</Btn>
          <Btn variant="outline" className="w-full px-2 py-2" onClick={onEdit} data-testid={`edit-order-mobile-${order.id}`}><Pencil size={16} /> Edit</Btn>
        </div>
        <div className="flex items-center gap-2">
          {canAdvance && <Btn variant="success" className="min-w-0 flex-1 px-3 py-2" onClick={onAdvance} data-testid={`advance-order-mobile-${order.id}`}>{statusLabel(nextStatus)} <ArrowRight size={14} /></Btn>}
          {moreButton}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <button type="button" onClick={onView} className={iconButtonClass} title="View order" aria-label={`View order ${order.reference}`} data-testid={`view-order-${order.id}`}><Eye size={15} /></button>
      <button type="button" onClick={onNote} className={iconButtonClass} title="Delivery note" aria-label={`Delivery note for ${order.reference}`} data-testid={`note-order-${order.id}`}><FileText size={15} /></button>
      <button type="button" onClick={onEdit} className={iconButtonClass} title="Edit order" aria-label={`Edit order ${order.reference}`} data-testid={`edit-order-${order.id}`}><Pencil size={15} /></button>
      {canAdvance && <button type="button" onClick={onAdvance} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-800 transition-colors hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300" data-testid={`advance-order-${order.id}`}>{statusLabel(nextStatus)}<ArrowRight size={13} /></button>}
      {moreButton}
    </div>
  );
}

function NoteModal({ order, vehicleName, settings, onClose }) {
  const ref = useRef(null);
  const [lang, setLang] = useState("en");
  const [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState(null);
  const [signatureLoading, setSignatureLoading] = useState(false);
  const [invoiceSnapshot, setInvoiceSnapshot] = useState(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState(false);
  useEffect(() => {
    if (!order?.id) return undefined;
    let active = true;
    setSignature(null);
    setInvoiceSnapshot(null);
    setInvoiceError(false);
    setInvoiceLoading(Boolean(order.invoice_id));
    setSignatureLoading(true);
    api.get(`/orders/${order.id}/driver-confirmation`)
      .then((result) => {
        if (!active) return;
        setSignature(result.signature_data ? result : null);
        const savedInvoice = result.confirmation_snapshot?.invoice_snapshot;
        const currentInvoice = savedInvoice || result.invoice_snapshot;
        setInvoiceSnapshot(currentInvoice);
        if (order.invoice_id && !currentInvoice) {
          setInvoiceError(true);
          toast.error("The linked invoice could not be verified. Driver confirmation is unavailable.");
        }
      })
      .catch((error) => { if (active) toast.error(apiError(error)); })
      .finally(() => {
        if (!active) return;
        setSignatureLoading(false);
        setInvoiceLoading(false);
      });
    return () => { active = false; };
  }, [order?.id]);
  const pdf = async () => { setBusy(true); try { await elementToPdf(ref.current, `${documentFilename("Delivery-note", order.customer_name || "Customer", order.reference, lang)}.pdf`); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  const saveDriverConfirmation = async (signatureData, driverName) => {
    try {
      const saved = await api.post(`/orders/${order.id}/driver-confirmation`, {
        signature_data: signatureData,
        driver_name: driverName,
        driver_confirmed: true,
      });
      setSignature({ ...saved, signature_data: signatureData });
      setInvoiceSnapshot(saved.confirmation_snapshot?.invoice_snapshot || null);
      toast.success("Driver confirmation signed and saved");
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const signedSnapshot = signature?.confirmation_snapshot;
  const signedOrder = order && signedSnapshot ? {
    ...order,
    reference: signedSnapshot.order_reference || order.reference,
    invoice_number: signedSnapshot.invoice_snapshot?.invoice_number || signedSnapshot.invoice_number || order.invoice_number,
    items: signedSnapshot.items,
    products: signedSnapshot.products,
  } : order;
  return (
    <Modal open={!!order} onClose={onClose} title={`Delivery Note ${order?.reference || ""}`} wide>
      {order && <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44"><Select label="Language" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="note-lang-select"><option value="en">English</option><option value="ur">Urdu (اردو)</option></Select></div>
          <Btn variant="outline" disabled={signatureLoading} onClick={() => printElement(ref.current, order.reference) || toast.error("Allow pop-ups to print")} data-testid="note-print-btn"><Printer size={15} /> Print</Btn>
          <Btn disabled={busy || signatureLoading} onClick={pdf} data-testid="note-pdf-btn"><Download size={15} /> {busy ? "Generating PDF..." : "Download PDF"}</Btn>
        </div>
        {signatureLoading || invoiceLoading ? <p className="text-sm text-slate-500" role="status">Loading order and invoice details...</p> : invoiceError
          ? <p className="text-sm text-red-700" role="alert">Cannot confirm delivery until the linked invoice can be verified.</p>
          : signature
          ? <p className="text-sm text-emerald-700">Confirmed by driver {signature.driver_name} on {new Date(signature.confirmed_at).toLocaleString()}</p>
          : <SignatureCapture onSave={saveDriverConfirmation} />}
        <div className="overflow-x-auto bg-slate-100 p-4 rounded-lg"><div className="shadow-md w-fit mx-auto"><DeliveryNote ref={ref} order={signedOrder} signature={signature} invoiceSnapshot={invoiceSnapshot} lang={lang} vehicleName={vehicleName} settings={settings} /></div></div>
      </div>}
    </Modal>
  );
}

function SignatureCapture({ onSave }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const [driverName, setDriverName] = useState("");
  const [hasInk, setHasInk] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const point = (event) => {
    const canvas = canvasRef.current;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    };
  };
  const startDrawing = (event) => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const { x, y } = point(event);
    drawing.current = true;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(x, y);
  };
  const draw = (event) => {
    if (!drawing.current) return;
    const context = canvasRef.current.getContext("2d");
    const { x, y } = point(event);
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#111827";
    context.lineTo(x, y);
    context.stroke();
    setHasInk(true);
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };
  const submit = async () => {
    setSaving(true);
    try {
      await onSave(canvasRef.current.toDataURL("image/png"), driverName.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-white p-3">
      <p className="text-sm font-semibold text-slate-800">Driver delivery confirmation</p>
      <p className="text-sm text-slate-600">The driver must check the listed products and quantities against the order and linked invoice before signing.</p>
      <canvas
        ref={canvasRef}
        width={720}
        height={180}
        aria-label="Draw driver signature"
        data-testid="delivery-signature-canvas"
        className="h-36 w-full touch-none rounded border border-dashed border-slate-400 bg-white"
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={() => { drawing.current = false; }}
        onPointerCancel={() => { drawing.current = false; }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1"><Input label="Driver name *" value={driverName} maxLength={100} onChange={(event) => setDriverName(event.target.value)} data-testid="delivery-signature-name" /></div>
        <Btn variant="outline" onClick={clear} disabled={!hasInk || saving}><RotateCcw size={15} /> Clear</Btn>
        <Btn onClick={submit} disabled={!hasInk || !driverName.trim() || !confirmed || saving} data-testid="delivery-signature-save">{saving ? "Saving..." : "Confirm and sign"}</Btn>
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="delivery-driver-confirmation"
          className="mt-1"
        />
        <span>I confirm that the pieces loaded for this delivery are complete and that their products and quantities match this order and its linked invoice, if present.</span>
      </label>
      <p className="text-xs text-slate-500">The signature and confirmation are sent once when you select “Confirm and sign”.</p>
    </div>
  );
}

export default function Orders() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [filter, setFilter] = useState("open");
  const [orderDate, setOrderDate] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState(null);
  const [viewOrder, setViewOrder] = useState(null);
  const [visibleInvoiceItems, setVisibleInvoiceItems] = useState(50);
  const [stock, setStock] = useState([]);
  const [prices, setPrices] = useState([]);
  const [settings, setSettings] = useState({});
  const [viewInvoice, setViewInvoice] = useState(null);
  const [formDataLoading, setFormDataLoading] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState({});
  const [smartArrangement, setSmartArrangement] = useState(null);
  const [smartArrangementLoading, setSmartArrangementLoading] = useState(false);
  const detailRequest = useRef(0);
  const products = [...new Set(stock.map((s) => s.product))];
  const sizesForProduct = (product) => {
    const normalized = String(product || "").trim().toLowerCase();
    const matchingPriceCategories = priceCategoriesForProduct(product).map((category) => String(category || "").toLowerCase());
    const catalogSizes = SIZE_CATALOG[normalized] || STANDARD_SIZES;
    return [...new Set([
      ...catalogSizes,
      ...stock.filter((item) => String(item.product || "").trim().toLowerCase() === normalized).map((item) => item.size),
      ...prices.filter((price) => price.active !== false && matchingPriceCategories.includes(String(price.category || "").trim().toLowerCase())).map((price) => price.size),
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  };
  const viewOrderLines = useMemo(() => viewOrder ? orderLines(viewOrder) : [], [viewOrder]);
  const viewInvoiceItems = Array.isArray(viewInvoice?.items) ? viewInvoice.items.filter((item) => item && typeof item === "object") : [];

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
    api.get("/orders", {
      page,
      page_size: 50,
      status: filter,
      order_date: orderDate || undefined,
      q: debouncedQ,
    }).then((result) => {
      if (!active) return;
      setList(result.items);
      setTotal(result.total);
      setStatusCounts(result.status_counts || {});
      const lastPage = Math.max(1, Math.ceil(result.total / 50));
      if (page > lastPage) setPage(lastPage);
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [page, filter, orderDate, debouncedQ, reload, user?.company_id]);

  useEffect(() => {
    api.get("/vehicles").then(setVehicles).catch((e) => toast.error(apiError(e)));
    api.get("/settings").then(setSettings).catch((e) => toast.error(apiError(e)));
  }, [user?.company_id]);

  useEffect(() => {
    if (!modal) return undefined;
    let active = true;
    setFormDataLoading(true);
    Promise.all([
      api.get("/customers"),
      api.get("/invoices"),
      api.get("/stock"),
      api.get("/prices"),
    ]).then(([customerData, invoiceData, stockData, priceData]) => {
      if (!active) return;
      setCustomers(customerData);
      setInvoices(invoiceData);
      setStock(stockData);
      setPrices(priceData);
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    }).finally(() => {
      if (active) setFormDataLoading(false);
    });
    return () => { active = false; };
  }, [Boolean(modal), user?.company_id]);

  const vName = (id) => vehicles.find((v) => v.id === id)?.name;
  const shown = list;
  const count = (status) => statusCounts[status] || 0;
  const load = () => setReload((current) => current + 1);
  const canMakeSmartArrangement = user?.company_id === "superiqfoam"
    && !user?.is_worker
    && (user?.is_owner || user?.is_admin || user?.is_company_owner);
  const selectableOrders = shown.filter((order) =>
    ["To Send", "Preparing", "Assigned", "Partially Delivered"].includes(order.status),
  );
  const selectedOrderList = Object.values(selectedOrders);
  const allVisibleSelected = selectableOrders.length > 0
    && selectableOrders.every((order) => selectedOrders[order.id]);

  const toggleOrderSelection = (order, checked) => {
    setSelectedOrders((current) => {
      const next = { ...current };
      if (checked) next[order.id] = order;
      else delete next[order.id];
      return next;
    });
  };

  const toggleVisibleOrderSelection = (checked) => {
    setSelectedOrders((current) => {
      const next = { ...current };
      for (const order of selectableOrders) {
        if (checked) next[order.id] = order;
        else delete next[order.id];
      }
      return next;
    });
  };

  const generateSmartArrangement = async () => {
    if (!canMakeSmartArrangement) return toast.error("Smart Production Planner is only available to SUPERIQFOAM administrators.");
    if (!selectedOrderList.length) return toast.error("Select at least one open order.");
    setSmartArrangementLoading(true);
    try {
      const plan = await api.post("/orders/smart-production-arrangements", {
        order_ids: selectedOrderList.map((order) => order.id),
      });
      setSmartArrangement(plan);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSmartArrangementLoading(false);
    }
  };

  const revalidateSmartArrangement = async () => {
    if (!smartArrangement?.order_ids?.length) return;
    setSmartArrangementLoading(true);
    try {
      const plan = await api.post("/orders/smart-production-arrangements", {
        order_ids: smartArrangement.order_ids,
      });
      setSmartArrangement(plan);
      toast.success("Order and floor-stock availability revalidated.");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSmartArrangementLoading(false);
    }
  };

  const releaseSmartArrangement = async () => {
    if (!smartArrangement?.id) return;
    if (!window.confirm("Release this arrangement proposal and its planning-only stock allocations? No production or inventory records will be changed.")) return;
    try {
      await api.del("/orders/smart-production-arrangements/" + smartArrangement.id);
      toast.success("Arrangement proposal released.");
      setSmartArrangement(null);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const pickCustomer = (id) => {
    const c = customers.find((x) => x.id === id);
    setModal({
      ...modal,
      customer_id: id,
      customer_name: c?.name || "",
      customer_address: c?.address || "",
      customer_phone: c?.phone || "",
      customer_email: c?.email || "",
      invoice_id: "",
      invoice_number: "",
      destination: c?.city || c?.address || "",
      items: [{ qty: "", category: "", size: "" }],
      products: "",
    });
  };

  const pickInvoice = (id) => {
    const invoice = invoices.find((item) => item.id === id);
    if (!invoice) {
      setModal({ ...modal, invoice_id: "", invoice_number: "", items: [{ qty: "", category: "", size: "" }], products: "" });
      return;
    }
    const items = (invoice.items || []).filter((item) => Number(item.qty) > 0 && (item.category || item.size || item.description)).map((item) => ({
      qty: item.qty,
      category: item.category || "",
      size: item.size || "",
      description: item.description || "",
    }));
    setModal({
      ...modal,
      invoice_id: invoice.id,
      invoice_number: invoice.number || invoice.reference || "",
      destination: invoice.destination || modal.destination,
      items,
      products: items.map((item) => `${item.qty} x ${[item.category, item.size, item.description].filter(Boolean).join(" ")}`).join("\n"),
    });
  };
  const openOrder = async (order) => {
    const requestId = ++detailRequest.current;
    setViewOrder(order);
    setViewInvoice(null);
    if (!order.invoice_id) return;
    try {
      const invoice = await api.get(`/invoices/${order.invoice_id}`);
      if (detailRequest.current === requestId) setViewInvoice(invoice);
    } catch (error) {
      if (detailRequest.current === requestId) toast.error(`Order loaded, but linked invoice details could not be loaded: ${apiError(error)}`);
    }
  };

  const save = async () => {
    if (!modal.customer_id && !modal.customer_name.trim()) return toast.error("Customer required");
    if (!modal.destination.trim()) return toast.error("City / destination required");
    try {
      const items = (modal.items || []).filter((i) => Number(i.qty) > 0 && (i.category || i.size || i.description)).map((i) => ({ ...i, qty: Number(i.qty) }));
      const payload = { ...modal, items, products: items.map((i) => `${i.qty} x ${[i.category, i.size, i.description].filter(Boolean).join(" ")}`).join("\n") || modal.products };
      if (modal.id) await api.put(`/orders/${modal.id}`, payload);
      else await api.post("/orders", payload);
      toast.success("Order saved"); setModal(null); setPage(1); load();
    } catch (e) { toast.error(apiError(e)); }
  };

  const scanOrderProduct = async (code) => {
    try {
      const product = await api.post("/products/scan", {
        code,
        scan_id: globalThis.crypto?.randomUUID?.(),
      });
      const category = products.find((item) => item.trim().toLowerCase() === product.product.trim().toLowerCase());
      if (!category || !sizesForProduct(category).includes(product.dimensions)) {
        toast.error(`${product.product} · ${product.dimensions} is not available in this order catalog`);
        return;
      }
      setModal((current) => {
        if (!current) return current;
        const items = [...(current.items || [])];
        const existingIndex = items.findIndex((item) =>
          item.category === category && item.size === product.dimensions
        );
        if (existingIndex >= 0) {
          items[existingIndex] = { ...items[existingIndex], qty: Number(items[existingIndex].qty || 0) + 1 };
        } else {
          const emptyIndex = items.findIndex((item) => !item.category && !item.size && !item.description);
          const scannedItem = { qty: 1, category, size: product.dimensions };
          if (emptyIndex >= 0) items[emptyIndex] = { ...items[emptyIndex], ...scannedItem };
          else items.push(scannedItem);
        }
        return { ...current, items };
      });
      toast.success(`${product.product} · ${product.dimensions} added to this order`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const advance = async (o) => {
    const next = STATUSES[STATUSES.indexOf(o.status) + 1];
    try { await api.put(`/orders/${o.id}`, { ...o, status: next }); toast.success(`Marked ${statusLabel(next)}`); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const remove = async (o) => {
    if (!window.confirm(`Cancel order ${o.reference}? The order record will be retained.`)) return;
    try { await api.del(`/orders/${o.id}`); toast.success("Order cancelled"); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const purge = async (o) => {
    if (!window.confirm(`PERMANENTLY delete order ${o.reference}? This cannot be undone.`)) return;
    try { await api.del(`/orders/${o.id}?permanent=true`); toast.success("Order permanently deleted"); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const tabs = ["open", ...STATUSES, "all"];
  return (
    <div className="space-y-6">
      <PageHeader title="Orders to Send" subtitle="Track orders waiting to be prepared and shipped">
        <Btn onClick={() => setModal(blank())} data-testid="add-order-btn"><Plus size={16} /> New Order</Btn>
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t} onClick={() => { setFilter(t); setPage(1); }} data-testid={`order-filter-${t.toLowerCase().replace(/\s/g, "-")}`}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${filter === t ? "bg-primary text-white border-primary" : "bg-white text-slate-600 border-border hover:border-primary"}`}>
            {t === "open" ? "Open" : t === "all" ? "All" : statusLabel(t)} <span className="opacity-70 ml-1">{loading ? "..." : count(t)}</span>
          </button>
        ))}
        <div className="ml-auto w-48"><Input label="Order date" type="date" value={orderDate} onChange={(event) => { setOrderDate(event.target.value); setPage(1); }} data-testid="order-date-filter" /></div>
      </div>
      {canMakeSmartArrangement && <Card className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(event) => toggleVisibleOrderSelection(event.target.checked)}
            disabled={!selectableOrders.length || loading}
            data-testid="select-visible-orders"
            aria-label="Select all visible open orders"
          />
          Select visible open orders
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {selectedOrderList.length > 0 && <span className="text-xs font-medium text-slate-600">{selectedOrderList.length} selected</span>}
          <Btn variant="outline" onClick={() => setSelectedOrders({})} disabled={!selectedOrderList.length} data-testid="clear-order-selection">Clear selection</Btn>
          <Btn onClick={generateSmartArrangement} disabled={!selectedOrderList.length || smartArrangementLoading} data-testid="make-arrangement">
            <Factory size={15} /> Make Arrangement
          </Btn>
        </div>
      </Card>}
      <Card className="p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search reference, customer, invoice, destination, products..."
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary" data-testid="order-search" />
        </div>
      </Card>
      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading orders...</p> : shown.length === 0 ? <Empty icon={ClipboardList} title="No orders here" hint="Create an order to start tracking shipments." /> : (
          <>
            <div className="space-y-3 p-3 sm:hidden">
              {shown.map((o) => (
                <article key={o.id} className="rounded-lg border border-border bg-white p-3 shadow-sm" data-testid={`order-card-${o.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {canMakeSmartArrangement && ["To Send", "Preparing", "Assigned", "Partially Delivered"].includes(o.status) && <label className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500">
                        <input
                          type="checkbox"
                          checked={!!selectedOrders[o.id]}
                          onChange={(event) => toggleOrderSelection(o, event.target.checked)}
                          data-testid={`select-order-${o.id}`}
                          aria-label={`Select order ${o.reference}`}
                        />
                        Select for arrangement
                      </label>}
                      <p className="break-all font-mono text-sm font-bold text-slate-800">{o.reference}</p>
                      {o.invoice_number && <p className="mt-0.5 text-xs text-slate-500">Invoice {o.invoice_number}</p>}
                    </div>
                    <Badge cls={S_META[o.status]}>{statusLabel(o.status)}</Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <div className="col-span-2 min-w-0">
                      <dt className="text-xs font-medium text-slate-500">Customer</dt>
                      <dd className="break-words font-semibold text-slate-800">{o.customer_name || "-"}</dd>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <dt className="text-xs font-medium text-slate-500">Products</dt>
                      <dd className="whitespace-pre-line break-words text-slate-700">{orderLines(o).map((line) => `${line.qty} × ${[line.category, line.size].filter(Boolean).join(" ")}`).join("\n") || "-"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs font-medium text-slate-500">Destination</dt>
                      <dd className="break-words text-slate-700">{o.destination || "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-slate-500">Ship date</dt>
                      <dd className="text-slate-700">{o.expected_ship_date ? fmtDate(o.expected_ship_date) : "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-slate-500">Priority</dt>
                      <dd className="mt-0.5"><Badge cls={P_META[o.priority]}>{o.priority}</Badge></dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs font-medium text-slate-500">Vehicle</dt>
                      <dd className="break-words text-slate-700">{vName(o.vehicle_id) || "-"}</dd>
                    </div>
                  </dl>
                  <OrderRowActions
                    order={o}
                    onView={() => { setVisibleInvoiceItems(50); void openOrder(o); }}
                    onNote={() => setNote(o)}
                    onEdit={() => setModal({ ...o, items: o.items?.length ? o.items : [{ qty: "", category: "", size: "" }], expected_ship_date: o.expected_ship_date || "" })}
                    onAdvance={() => advance(o)}
                    onCancel={() => remove(o)}
                    onPurge={() => purge(o)}
                    mobile
                  />
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm min-w-[960px]">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                {canMakeSmartArrangement && <th className="w-10 px-3 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => toggleVisibleOrderSelection(event.target.checked)} disabled={!selectableOrders.length || loading} aria-label="Select all visible open orders" data-testid="select-visible-orders-table" /></th>}
                <th className="px-4 py-3 font-semibold">Ref</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">City</th><th className="px-4 font-semibold">Products</th><th className="px-4 font-semibold">Priority</th><th className="px-4 font-semibold">Status</th><th className="px-4 font-semibold">Ship Date</th><th className="px-4 font-semibold">Vehicle</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{shown.map((o) => (
                <tr key={o.id} className="border-b border-border/60 hover:bg-slate-50 align-top" data-testid={`order-row-${o.id}`}>
                  {canMakeSmartArrangement && <td className="px-3 py-3">{["To Send", "Preparing", "Assigned", "Partially Delivered"].includes(o.status) && <input type="checkbox" checked={!!selectedOrders[o.id]} onChange={(event) => toggleOrderSelection(o, event.target.checked)} aria-label={`Select order ${o.reference}`} data-testid={`select-order-table-${o.id}`} />}</td>}
                  <td className="px-4 py-3 font-mono font-semibold text-slate-800 whitespace-nowrap">{o.reference}{o.invoice_number && <span className="block font-sans text-[10px] font-medium text-slate-400">Invoice {o.invoice_number}</span>}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700">{o.customer_name || "-"}</td>
                  <td className="px-4 py-3 text-slate-500">{o.destination}</td>
                  <td className="px-4 py-3 text-slate-600 max-w-[240px] whitespace-pre-line">{orderLines(o).map((l) => `${l.qty} × ${[l.category, l.size].filter(Boolean).join(" ")}`).join("\n") || "-"}</td>
                  <td className="px-4 py-3"><Badge cls={P_META[o.priority]}>{o.priority}</Badge></td>
                  <td className="px-4 py-3"><Badge cls={S_META[o.status]}>{statusLabel(o.status)}</Badge></td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{o.expected_ship_date ? fmtDate(o.expected_ship_date) : "-"}</td>
                  <td className="px-4 py-3 text-slate-500">{vName(o.vehicle_id) || "-"}</td>
                  <td className="px-3 py-2 align-middle">
                    <OrderRowActions
                      order={o}
                      onView={() => { setVisibleInvoiceItems(50); void openOrder(o); }}
                      onNote={() => setNote(o)}
                      onEdit={() => setModal({ ...o, items: o.items?.length ? o.items : [{ qty: "", category: "", size: "" }], expected_ship_date: o.expected_ship_date || "" })}
                      onAdvance={() => advance(o)}
                      onCancel={() => remove(o)}
                      onPurge={() => purge(o)}
                    />
                  </td>
                </tr>))}</tbody>
            </table>
            </div>
          </>
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
        <span>Showing {total === 0 ? 0 : (page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total} orders</span>
        <div className="flex gap-2">
          <Btn variant="outline" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)} data-testid="orders-previous-page">Previous</Btn>
          <span className="self-center">Page {page} of {Math.max(1, Math.ceil(total / 50))}</span>
          <Btn variant="outline" disabled={loading || page >= Math.ceil(total / 50)} onClick={() => setPage((current) => current + 1)} data-testid="orders-next-page">Next</Btn>
        </div>
      </div>

      <Modal open={!!viewOrder} onClose={() => setViewOrder(null)} title={`Order Details ${viewOrder?.reference || ""}`} wide>
        {viewOrder && <div className="max-h-[calc(100vh-9rem)] space-y-5 overflow-y-auto p-1 text-sm" data-testid={`order-details-${viewOrder.id}`}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            {[
              ["Order Number", viewOrder.reference],
              ["Invoice", viewOrder.invoice_number],
              ["Customer", viewOrder.customer_name],
              ["Customer Address", viewOrder.customer_address],
              ["Phone", viewOrder.customer_phone],
              ["Email", viewOrder.customer_email],
              ["Destination", viewOrder.destination],
              ["Ship Date", viewOrder.expected_ship_date ? fmtDate(viewOrder.expected_ship_date) : ""],
              ["Priority", viewOrder.priority],
              ["Status", statusLabel(viewOrder.status)],
              ["Vehicle", vName(viewOrder.vehicle_id)],
              ["Created", viewOrder.created_at ? fmtDateTime(viewOrder.created_at) : ""],
            ].filter(([, value]) => value !== undefined && value !== null && value !== "").map(([label, value]) => (
              <div key={label}><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-800">{value}</dd></div>
            ))}
          </dl>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Products</h4>
            {viewOrderLines.length ? <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Quantity</th><th className="px-3 py-2">Product</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Size / Measurements</th></tr></thead>
                <tbody>{viewOrderLines.slice(0, 100).map((line, index) => <tr key={index} className="border-t border-border/70">
                  <td className="px-3 py-2">{line.qty}</td><td className="px-3 py-2">{line.category || "-"}</td><td className="px-3 py-2">{line.description || "-"}</td><td className="px-3 py-2">{line.size || "-"}</td>
                </tr>)}</tbody>
              </table>{viewOrderLines.length > 100 && <p className="px-3 py-2 text-xs text-slate-500">Showing the first 100 of {viewOrderLines.length} order lines.</p>}
            </div> : <p className="text-slate-500">No product details recorded.</p>}
          </div>
          {viewInvoice && <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Linked Invoice Details</h4>
            {viewInvoiceItems.length > 0 && <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Product / Description</th><th className="px-3 py-2">Size</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Unit Price</th><th className="px-3 py-2 text-right">Line Total</th></tr></thead>
                <tbody>{viewInvoiceItems.slice(0, visibleInvoiceItems).map((item, index) => <tr key={index} className="border-t border-border/70">
                  <td className="px-3 py-2">{item.category || item.description || "Item"}</td><td className="px-3 py-2">{item.size || "-"}</td>
                  <td className="px-3 py-2 text-right">{item.qty}</td><td className="px-3 py-2 text-right">{fmtMoney(item.unit_price)}</td>
                  <td className="px-3 py-2 text-right">{fmtMoney(item.line_total ?? (Number(item.qty || 0) * Number(item.unit_price || 0)))}</td>
                </tr>)}</tbody>
              </table>{viewInvoiceItems.length > visibleInvoiceItems && <button onClick={() => setVisibleInvoiceItems((current) => current + 50)} className="w-full border-t border-border px-3 py-2 text-xs font-semibold text-primary hover:bg-slate-50">Show next {Math.min(50, viewInvoiceItems.length - visibleInvoiceItems)} invoice items ({viewInvoiceItems.length - visibleInvoiceItems} remaining)</button>}
            </div>}
            <dl className="ml-auto mt-3 grid max-w-sm grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-slate-50 p-4 text-sm">
              {[["Subtotal", viewInvoice.subtotal], ["Discount", viewInvoice.discount], ...(Number(viewInvoice.delivery_fee) ? [["Delivery Fee", viewInvoice.delivery_fee]] : []), ["Additional Charges", viewInvoice.extra_charges],
                ...(viewInvoice.tax_enabled ? [["Tax", viewInvoice.tax_amount]] : []),
                ["Total", viewInvoice.total], ["Amount Paid", viewInvoice.amount_paid], ["Outstanding Balance", viewInvoice.outstanding],
              ].map(([label, value]) => <div key={label} className="contents"><dt className="font-semibold text-slate-600">{label}</dt><dd className="text-right font-mono">{fmtMoney(value)}</dd></div>)}
            </dl>
            {(viewInvoice.made_by || viewInvoice.client_number || viewInvoice.assigned_driver_name) && <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              {viewInvoice.made_by && <p><span className="font-semibold text-slate-600">Made By:</span> {viewInvoice.made_by}</p>}
              {viewInvoice.client_number && <p><span className="font-semibold text-slate-600">Client Number:</span> {viewInvoice.client_number}</p>}
              {viewInvoice.assigned_driver_name && <p><span className="font-semibold text-slate-600">Assigned Driver:</span> {viewInvoice.assigned_driver_name}</p>}
            </div>}
          </div>}
          {viewOrder.notes && <div><h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</h4><p className="mt-1 whitespace-pre-wrap text-slate-800">{viewOrder.notes}</p></div>}
        </div>}
      </Modal>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? `Edit Order ${modal.reference}` : "New Order"} wide>
        {modal && <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label="Customer *" value={modal.customer_id} onChange={(e) => pickCustomer(e.target.value)} disabled={formDataLoading} data-testid="order-customer-select">
              <option value="">{formDataLoading ? "Loading customers..." : "Select customer..."}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {!modal.id && <Select label="Invoice" value={modal.invoice_id || ""} onChange={(e) => pickInvoice(e.target.value)} disabled={!modal.customer_id} data-testid="order-invoice-select">
              <option value="">Select an invoice...</option>
              {invoices.filter((invoice) => invoice.customer_id === modal.customer_id && !invoice.opening_balance && invoice.status !== "void").map((invoice) => (
                <option key={invoice.id} value={invoice.id}>{invoice.number || invoice.reference || invoice.id} · {invoice.date || "Undated"}</option>
              ))}
            </Select>}
            <Input label="City / Destination *" value={modal.destination} onChange={(e) => setModal({ ...modal, destination: e.target.value })} data-testid="order-destination-input" />
            <Select label="Priority" value={modal.priority} onChange={(e) => setModal({ ...modal, priority: e.target.value })} data-testid="order-priority-select">
              {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Status" value={modal.status} onChange={(e) => setModal({ ...modal, status: e.target.value })} data-testid="order-status-select">
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </Select>
            <Input label="Expected Ship Date" type="date" value={modal.expected_ship_date} onChange={(e) => setModal({ ...modal, expected_ship_date: e.target.value })} data-testid="order-ship-date-input" />
            <Select label="Assigned Vehicle" value={modal.vehicle_id} onChange={(e) => setModal({ ...modal, vehicle_id: e.target.value })} data-testid="order-vehicle-select">
              <option value="">Not assigned</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}{v.length ? ` (${v.length})` : ""}</option>)}
            </Select>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Products (no prices)</p>
            <div className="mb-3"><BarcodeScanner onScan={scanOrderProduct} dedupeWindowMs={0} label="Scan product to add it to this order" /></div>
            <div className="space-y-2">{modal.items.map((it, i) => {
              const set = (patch) => setModal({ ...modal, items: modal.items.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="flex gap-2" data-testid={`order-item-${i}`}>
                  <input type="number" min="0" placeholder="Qty" value={it.qty} onChange={(e) => set({ qty: e.target.value })} className="w-20 rounded border border-input px-2 py-1.5 text-sm" data-testid={`order-item-qty-${i}`} />
                  <select value={it.category} onChange={(e) => set({ category: e.target.value, size: "" })} className="flex-1 rounded border border-input px-2 py-1.5 text-sm" data-testid={`order-item-cat-${i}`}>
                    <option value="">Product...</option>{it.category && !products.includes(it.category) && <option>{it.category}</option>}{products.map((p) => <option key={p}>{p}</option>)}</select>
                  <select value={it.size} onChange={(e) => set({ size: e.target.value })} className="w-32 rounded border border-input px-2 py-1.5 text-sm" data-testid={`order-item-size-${i}`}>
                    <option value="">Size...</option>{it.size && !sizesForProduct(it.category).includes(it.size) && <option>{it.size}</option>}{sizesForProduct(it.category).map((size) => <option key={size}>{size}</option>)}</select>
                  <button onClick={() => setModal({ ...modal, items: modal.items.filter((_, k) => k !== i) })} className="text-slate-300 hover:text-red-600"><Trash2 size={15} /></button>
                </div>);
            })}</div>
            <Btn variant="outline" className="mt-2" onClick={() => setModal({ ...modal, items: [...modal.items, { qty: "", category: "", size: "" }] })} data-testid="order-add-item-btn"><Plus size={14} /> Add product</Btn>
          </div>
          <Textarea label="Notes" rows={2} value={modal.notes} onChange={(e) => setModal({ ...modal, notes: e.target.value })} data-testid="order-notes-input" />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setModal(null)}>Cancel</Btn><Btn onClick={save} data-testid="save-order-btn">Save Order</Btn></div>
        </div>}
      </Modal>
      <NoteModal order={note} vehicleName={note ? vName(note.vehicle_id) : ""} settings={settings} onClose={() => setNote(null)} />
      {(smartArrangement || smartArrangementLoading) && <SmartProductionPlanner
        plan={smartArrangement}
        loading={smartArrangementLoading}
        onRefresh={revalidateSmartArrangement}
        onRelease={releaseSmartArrangement}
        onClose={() => setSmartArrangement(null)}
      />}
    </div>
  );
}
