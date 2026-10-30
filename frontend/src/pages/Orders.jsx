import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtMoney, documentFilename } from "@/lib/format";
import { Card, Btn, Input, Select, Textarea, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { ClipboardList, Plus, Trash2, Pencil, ArrowRight, Eye, FileText, Printer, Download } from "lucide-react";
import { useRef } from "react";
import { DeliveryNote, orderLines } from "@/components/DeliveryNote";
import { elementToPdf, printElement } from "@/lib/pdf";
import BarcodeScanner from "@/components/BarcodeScanner";

const STATUSES = ["To Send", "Preparing", "Assigned", "Dispatched", "Delivered", "Cancelled"];
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
const P_RANK = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
const OPEN = ["To Send", "Preparing", "Assigned"];
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

function NoteModal({ order, vehicleName, settings, onClose }) {
  const ref = useRef(null);
  const [lang, setLang] = useState("en");
  const [busy, setBusy] = useState(false);
  const pdf = async () => { setBusy(true); try { await elementToPdf(ref.current, `${documentFilename("Delivery-note", order.customer_name || "Customer", order.reference, lang)}.pdf`); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  return (
    <Modal open={!!order} onClose={onClose} title={`Delivery Note ${order?.reference || ""}`} wide>
      {order && <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44"><Select label="Language" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="note-lang-select"><option value="en">English</option><option value="ur">Urdu (اردو)</option></Select></div>
          <Btn variant="outline" onClick={() => printElement(ref.current, order.reference) || toast.error("Allow pop-ups to print")} data-testid="note-print-btn"><Printer size={15} /> Print</Btn>
          <Btn disabled={busy} onClick={pdf} data-testid="note-pdf-btn"><Download size={15} /> {busy ? "Generating PDF..." : "Download PDF"}</Btn>
        </div>
        <div className="overflow-x-auto bg-slate-100 p-4 rounded-lg"><div className="shadow-md w-fit mx-auto"><DeliveryNote ref={ref} order={order} lang={lang} vehicleName={vehicleName} settings={settings} /></div></div>
      </div>}
    </Modal>
  );
}

export default function Orders() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [filter, setFilter] = useState("open");
  const [orderDate, setOrderDate] = useState("");
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState(null);
  const [viewOrder, setViewOrder] = useState(null);
  const [visibleInvoiceItems, setVisibleInvoiceItems] = useState(50);
  const [stock, setStock] = useState([]);
  const [prices, setPrices] = useState([]);
  const [settings, setSettings] = useState({});
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
  const viewInvoice = viewOrder && invoices.find((invoice) => invoice.id === viewOrder.invoice_id);
  const viewOrderLines = useMemo(() => viewOrder ? orderLines(viewOrder) : [], [viewOrder]);
  const viewInvoiceItems = Array.isArray(viewInvoice?.items) ? viewInvoice.items.filter((item) => item && typeof item === "object") : [];

  const load = () => { api.get("/orders").then(setList).catch((e) => toast.error(apiError(e))).finally(() => setLoading(false)); };
  useEffect(() => {
    load();
    api.get("/customers").then(setCustomers).catch((e) => toast.error(apiError(e)));
    api.get("/invoices").then(setInvoices).catch((e) => toast.error(apiError(e)));
    api.get("/vehicles").then(setVehicles).catch((e) => toast.error(apiError(e)));
    api.get("/stock").then(setStock).catch((e) => toast.error(apiError(e)));
    api.get("/prices").then(setPrices).catch((e) => toast.error(apiError(e)));
    api.get("/settings").then(setSettings).catch((e) => toast.error(apiError(e)));
  }, []);

  const vName = (id) => vehicles.find((v) => v.id === id)?.name;
  const shown = useMemo(() => {
    const f = filter === "open" ? list.filter((o) => OPEN.includes(o.status)) : filter === "all" ? list : list.filter((o) => o.status === filter);
    const dated = orderDate ? f.filter((order) => order.created_at && new Date(order.created_at).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }) === orderDate) : f;
    return [...dated].sort((a, b) => (P_RANK[a.priority] ?? 9) - (P_RANK[b.priority] ?? 9) || (a.expected_ship_date || "9").localeCompare(b.expected_ship_date || "9"));
  }, [list, filter, orderDate]);
  const count = (s) => (s === "open" ? list.filter((o) => OPEN.includes(o.status)).length : s === "all" ? list.length : list.filter((o) => o.status === s).length);

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

  const save = async () => {
    if (!modal.customer_id && !modal.customer_name.trim()) return toast.error("Customer required");
    if (!modal.destination.trim()) return toast.error("City / destination required");
    try {
      const items = (modal.items || []).filter((i) => Number(i.qty) > 0 && (i.category || i.size || i.description)).map((i) => ({ ...i, qty: Number(i.qty) }));
      const payload = { ...modal, items, products: items.map((i) => `${i.qty} x ${[i.category, i.size, i.description].filter(Boolean).join(" ")}`).join("\n") || modal.products };
      if (modal.id) await api.put(`/orders/${modal.id}`, payload);
      else await api.post("/orders", payload);
      toast.success("Order saved"); setModal(null); load();
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
    try { await api.put(`/orders/${o.id}`, { ...o, status: next }); toast.success(`Marked ${next}`); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const remove = async (o) => {
    if (!window.confirm(`Cancel order ${o.reference}? The order record will be retained.`)) return;
    try { await api.del(`/orders/${o.id}`); toast.success("Order cancelled"); load(); } catch (e) { toast.error(apiError(e)); }
  };

  const tabs = ["open", ...STATUSES, "all"];
  return (
    <div className="space-y-6">
      <PageHeader title="Orders to Send" subtitle="Track orders waiting to be prepared and shipped">
        <Btn onClick={() => setModal(blank())} data-testid="add-order-btn"><Plus size={16} /> New Order</Btn>
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t} onClick={() => setFilter(t)} data-testid={`order-filter-${t.toLowerCase().replace(/\s/g, "-")}`}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${filter === t ? "bg-primary text-white border-primary" : "bg-white text-slate-600 border-border hover:border-primary"}`}>
            {t === "open" ? "Open" : t === "all" ? "All" : t} <span className="opacity-70 ml-1">{loading ? "..." : count(t)}</span>
          </button>
        ))}
        <div className="ml-auto w-48"><Input label="Order date" type="date" value={orderDate} onChange={(event) => setOrderDate(event.target.value)} data-testid="order-date-filter" /></div>
      </div>

      <Card className="overflow-hidden">
        {loading ? <p className="p-6 text-sm text-slate-400" role="status">Loading orders...</p> : shown.length === 0 ? <Empty icon={ClipboardList} title="No orders here" hint="Create an order to start tracking shipments." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[960px]">
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="px-4 py-3 font-semibold">Ref</th><th className="px-4 font-semibold">Customer</th><th className="px-4 font-semibold">City</th><th className="px-4 font-semibold">Products</th><th className="px-4 font-semibold">Priority</th><th className="px-4 font-semibold">Status</th><th className="px-4 font-semibold">Ship Date</th><th className="px-4 font-semibold">Vehicle</th><th className="px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{shown.map((o) => (
                <tr key={o.id} className="border-b border-border/60 hover:bg-slate-50 align-top" data-testid={`order-row-${o.id}`}>
                  <td className="px-4 py-3 font-mono font-semibold text-slate-800 whitespace-nowrap">{o.reference}{o.invoice_number && <span className="block font-sans text-[10px] font-medium text-slate-400">Invoice {o.invoice_number}</span>}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700">{o.customer_name || "-"}</td>
                  <td className="px-4 py-3 text-slate-500">{o.destination}</td>
                  <td className="px-4 py-3 text-slate-600 max-w-[240px] whitespace-pre-line">{orderLines(o).map((l) => `${l.qty} × ${[l.category, l.size].filter(Boolean).join(" ")}`).join("\n") || "-"}</td>
                  <td className="px-4 py-3"><Badge cls={P_META[o.priority]}>{o.priority}</Badge></td>
                  <td className="px-4 py-3"><Badge cls={S_META[o.status]}>{o.status}</Badge></td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{o.expected_ship_date ? fmtDate(o.expected_ship_date) : "-"}</td>
                  <td className="px-4 py-3 text-slate-500">{vName(o.vehicle_id) || "-"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => { setVisibleInvoiceItems(50); setViewOrder(o); }} className="text-slate-400 hover:text-primary mr-3" title="View order" aria-label={`View order ${o.reference}`} data-testid={`view-order-${o.id}`}><Eye size={15} /></button>
                    {o.status !== "Delivered" && o.status !== "Cancelled" && (
                      <button onClick={() => advance(o)} className="inline-flex items-center gap-1 text-emerald-600 hover:underline text-xs font-semibold mr-3" data-testid={`advance-order-${o.id}`}>
                        {STATUSES[STATUSES.indexOf(o.status) + 1]} <ArrowRight size={12} />
                      </button>)}
                    <button onClick={() => setNote(o)} className="text-slate-400 hover:text-primary mr-3" title="Delivery note" data-testid={`note-order-${o.id}`}><FileText size={15} /></button>
                    <button onClick={() => setModal({ ...o, items: o.items?.length ? o.items : [{ qty: "", category: "", size: "" }], expected_ship_date: o.expected_ship_date || "" })} className="text-slate-400 hover:text-primary mr-3" data-testid={`edit-order-${o.id}`}><Pencil size={15} /></button>
                    <button onClick={() => remove(o)} className="text-slate-400 hover:text-red-600" data-testid={`delete-order-${o.id}`}><Trash2 size={15} /></button>
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>

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
              ["Status", viewOrder.status],
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
              {[["Subtotal", viewInvoice.subtotal], ["Discount", viewInvoice.discount], ["Additional Charges", viewInvoice.extra_charges],
                ...(viewInvoice.tax_enabled ? [["Tax", viewInvoice.tax_amount]] : []),
                ["Total", viewInvoice.total], ["Amount Paid", viewInvoice.amount_paid], ["Outstanding Balance", viewInvoice.outstanding],
              ].map(([label, value]) => <div key={label} className="contents"><dt className="font-semibold text-slate-600">{label}</dt><dd className="text-right font-mono">{fmtMoney(value)}</dd></div>)}
            </dl>
          </div>}
          {viewOrder.notes && <div><h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</h4><p className="mt-1 whitespace-pre-wrap text-slate-800">{viewOrder.notes}</p></div>}
        </div>}
      </Modal>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.id ? `Edit Order ${modal.reference}` : "New Order"} wide>
        {modal && <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select label="Customer *" value={modal.customer_id} onChange={(e) => pickCustomer(e.target.value)} data-testid="order-customer-select">
              <option value="">Select customer...</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
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
    </div>
  );
}
