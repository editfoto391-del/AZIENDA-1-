import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Ban, Building2, ClipboardCheck, Clock3, Download, FileText, PackageCheck,
  Pencil, Plus, RefreshCw, RotateCcw, ShieldAlert,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtMoney, today } from "@/lib/format";
import { companyProfileName } from "@/lib/company";
import { Badge, Btn, Card, Empty, Input, Modal, PageHeader, Select, Textarea } from "@/components/common";

const STATUSES = [
  ["draft", "Draft"],
  ["pending_inspection", "Pending Inspection"],
  ["partially_received", "Partially Received"],
  ["completed", "Completed"],
  ["discrepancy", "Discrepancy"],
  ["cancelled", "Cancelled"],
];
const STATUS_STYLE = {
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  pending_inspection: "bg-blue-50 text-blue-700 border-blue-200",
  partially_received: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  discrepancy: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
  confirming: "bg-blue-50 text-blue-700 border-blue-200",
  reversing: "bg-orange-50 text-orange-700 border-orange-200",
};
const statusLabel = (status) => ({
  pending_inspection: "Pending Inspection",
  partially_received: "Partially Received",
  discrepancy: "Discrepancy",
  confirming: "Confirming",
  reversing: "Reversing",
}[status] || status?.replaceAll("_", " ") || "Unknown");
const blankLine = () => ({
  stock_id: "", product_code: "", product: "", size: "",
  purchase_order_item_index: null, ordered_quantity: 0,
  previously_received_quantity: 0, remaining_quantity: 0,
  actual_received_quantity: 0, accepted_quantity: 0, rejected_quantity: 0,
  damaged_quantity: 0, unit_cost: 0, total_value: 0,
});
const blankGRV = () => ({
  supplier_id: "", supplier_name: "", purchase_order_id: "",
  delivery_note_number: "", received_date: today(), received_by: "",
  warehouse: "", notes: "", items: [blankLine()],
});
const lineValue = (line) => (Number(line.accepted_quantity) || 0) * (Number(line.unit_cost) || 0);

function Metric({ label, value, icon: Icon, tone = "text-slate-800" }) {
  return (
    <Card className="p-4" data-testid={`grv-metric-${label.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
          <p className={`mt-2 text-2xl font-bold font-mono ${tone}`}>{value ?? 0}</p>
        </div>
        <span className="rounded-lg bg-slate-50 p-2 text-primary"><Icon size={19} /></span>
      </div>
    </Card>
  );
}

async function downloadGRVPdf(grv, companyName, settings = {}) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 15;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const right = pageWidth - margin;
  let y = 16;
  const addText = (text, x, top, options = {}) => {
    pdf.text(String(text ?? ""), x, top, options);
  };
  const ensureSpace = (height) => {
    if (y + height > pageHeight - 22) {
      pdf.addPage();
      y = 18;
    }
  };

  pdf.setFillColor(20, 72, 58);
  pdf.rect(0, 0, pageWidth, 38, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  addText(companyName || settings.company_name || "Company", margin, 16);
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "normal");
  addText("GOODS RECEIVED VOUCHER", margin, 27);
  pdf.setFontSize(7);
  const companyContact = [
    settings.address,
    settings.telephone,
    settings.email,
    settings.tax_number ? `Tax no. ${settings.tax_number}` : "",
  ].filter(Boolean).join(" · ");
  if (companyContact) addText(companyContact, margin, 34);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  addText(grv.grv_number, right, 16, { align: "right" });
  pdf.setFont("helvetica", "normal");
  addText(fmtDate(grv.received_date), right, 27, { align: "right" });

  pdf.setTextColor(35, 45, 54);
  y = 50;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  addText("SUPPLIER", margin, y);
  addText("PURCHASE ORDER", pageWidth / 2, y);
  pdf.setFont("helvetica", "normal");
  y += 6;
  addText(grv.supplier_name || "-", margin, y);
  addText(grv.purchase_order_reference || "Standalone receipt", pageWidth / 2, y);
  y += 7;
  pdf.setFont("helvetica", "bold");
  addText("DELIVERY NOTE", margin, y);
  addText("WAREHOUSE", pageWidth / 2, y);
  pdf.setFont("helvetica", "normal");
  y += 6;
  addText(grv.delivery_note_number || "-", margin, y);
  addText(grv.warehouse || "-", pageWidth / 2, y);
  y += 7;
  pdf.setFont("helvetica", "bold");
  addText("RECEIVED BY", margin, y);
  pdf.setFont("helvetica", "normal");
  addText(grv.received_by || "-", margin + 29, y);

  y += 12;
  const cols = [
    { title: "Product / size", x: margin, width: 45, align: "left" },
    { title: "Ordered", x: 63, width: 18, align: "right" },
    { title: "Received", x: 84, width: 18, align: "right" },
    { title: "Accepted", x: 105, width: 18, align: "right" },
    { title: "Rejected", x: 126, width: 18, align: "right" },
    { title: "Unit cost", x: 147, width: 22, align: "right" },
    { title: "Total", x: right - 23, width: 23, align: "right" },
  ];
  const drawHeader = () => {
    pdf.setFillColor(239, 244, 241);
    pdf.rect(margin, y - 5, pageWidth - margin * 2, 9, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(51, 65, 61);
    cols.forEach((column) => addText(
      column.title,
      column.align === "right" ? column.x + column.width : column.x,
      y,
      { align: column.align },
    ));
    y += 9;
  };
  drawHeader();
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  for (const line of grv.items || []) {
    ensureSpace(9);
    if (y === 18) drawHeader();
    const values = [
      `${line.product || ""} ${line.size || ""}${line.product_code ? ` · ${line.product_code}` : ""}`.trim(),
      line.ordered_quantity || 0,
      line.actual_received_quantity || 0,
      line.accepted_quantity || 0,
      line.rejected_quantity || 0,
      fmtMoney(line.unit_cost || 0),
      fmtMoney(line.total_value ?? lineValue(line)),
    ];
    values.forEach((value, index) => addText(
      String(value),
      cols[index].align === "right" ? cols[index].x + cols[index].width : cols[index].x,
      y,
      { align: cols[index].align },
    ));
    pdf.setDrawColor(225, 230, 227);
    pdf.line(margin, y + 2.5, right, y + 2.5);
    y += 8;
  }
  ensureSpace(38);
  y += 8;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  const total = (grv.items || []).reduce((sum, line) => sum + Number(line.total_value ?? lineValue(line)), 0);
  addText(`Accepted goods value: ${fmtMoney(total)}`, right, y, { align: "right" });
  y += 9;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  const notes = pdf.splitTextToSize(`Notes: ${grv.notes || "-"}`, pageWidth - margin * 2);
  pdf.text(notes, margin, y);
  y += notes.length * 4 + 8;
  ensureSpace(25);
  pdf.setDrawColor(90, 100, 95);
  pdf.line(margin, y + 9, margin + 65, y + 9);
  pdf.line(right - 65, y + 9, right, y + 9);
  pdf.setFontSize(8);
  addText("Receiver signature", margin, y + 14);
  addText("Supplier / driver signature", right, y + 14, { align: "right" });
  pdf.setTextColor(110, 120, 115);
  addText(`Status: ${statusLabel(grv.status)} · Generated ${new Date().toLocaleString()}`, margin, pageHeight - 9);
  pdf.save(`${grv.grv_number || "GRV"}.pdf`);
}

export default function GRV() {
  const { user } = useAuth();
  const companyId = user?.company_id || "";
  const [dashboard, setDashboard] = useState(null);
  const [records, setRecords] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stock, setStock] = useState([]);
  const [settings, setSettings] = useState({});
  const [filters, setFilters] = useState({ date_from: "", date_to: "", supplier_id: "", status: "" });
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState("");

  const refresh = useCallback(async () => {
    setRecords(null);
    const query = {
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      company_profile_id: companyId,
    };
    try {
      const [summary, grvs] = await Promise.all([
        api.get("/grvs/dashboard", query),
        api.get("/grvs", query),
      ]);
      setDashboard(summary);
      setRecords(grvs);
    } catch (error) {
      setRecords([]);
      toast.error(apiError(error));
    }
  }, [companyId, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    Promise.all([
      api.get("/suppliers"),
      api.get("/grvs/purchase-orders"),
      api.get("/stock"),
      api.get("/settings"),
    ]).then(([supplierList, orderList, stockList, businessSettings]) => {
      setSuppliers(supplierList);
      setOrders(orderList);
      setStock(stockList);
      setSettings(businessSettings || {});
    }).catch((error) => toast.error(apiError(error)));
  }, [companyId]);

  const totalValue = useMemo(
    () => (records || []).reduce((sum, grv) =>
      sum + (grv.items || []).reduce((lineSum, line) => lineSum + Number(line.total_value || 0), 0), 0),
    [records],
  );

  const updateLine = (index, key, value) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((line, lineIndex) => lineIndex === index
        ? { ...line, [key]: value }
        : line),
    }));
  };

  const chooseOrder = (orderId) => {
    if (!orderId) {
      setDraft((current) => ({ ...current, purchase_order_id: "", supplier_id: "", supplier_name: "", items: [blankLine()] }));
      return;
    }
    const order = orders.find((item) => item.id === orderId);
    if (!order) return;
    const lines = order.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => Number(item.remaining_quantity) > 0)
      .map(({ item, index }) => ({
        ...blankLine(),
        stock_id: item.stock_id,
        product_code: item.stock_id,
        product: item.product,
        size: item.size || "",
        purchase_order_item_index: index,
        ordered_quantity: Number(item.quantity || 0),
        previously_received_quantity: Number(item.received_quantity || 0),
        remaining_quantity: Number(item.remaining_quantity || 0),
        unit_cost: Number(item.unit_price || 0),
      }));
    setDraft((current) => ({
      ...current,
      purchase_order_id: orderId,
      supplier_id: order.supplier_id || "",
      supplier_name: order.supplier_name || "",
      items: lines,
    }));
  };

  const chooseStock = (index, stockId) => {
    const selected = stock.find((item) => item.id === stockId);
    if (!selected) {
      updateLine(index, "stock_id", "");
      return;
    }
    setDraft((current) => ({
      ...current,
      items: current.items.map((line, lineIndex) => lineIndex === index
        ? {
          ...line,
          stock_id: selected.id,
          product_code: selected.code || selected.sku || selected.id,
          product: selected.product,
          size: selected.size || "",
          unit_cost: Number(selected.unit_cost || 0),
        }
        : line),
    }));
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    if (saving || !draft) return;
    if (!draft.supplier_id && !draft.supplier_name.trim()) return toast.error("Choose a supplier");
    if (!draft.items.length || draft.items.some((line) => !line.stock_id)) return toast.error("Select a stock product for every line");
    setSaving(true);
    try {
      const payload = {
        ...draft,
        items: draft.items.map((line) => ({
          ...line,
          actual_received_quantity: Number(line.actual_received_quantity || 0),
          accepted_quantity: Number(line.accepted_quantity || 0),
          rejected_quantity: Number(line.rejected_quantity || 0),
          damaged_quantity: Number(line.damaged_quantity || 0),
          unit_cost: Number(line.unit_cost || 0),
        })),
      };
      if (draft.id) {
        await api.put(`/grvs/${draft.id}`, payload);
        toast.success("GRV draft updated");
      } else {
        await api.post("/grvs", payload);
        toast.success("GRV draft created");
      }
      setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const act = async (grv, action, confirmMessage) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setWorkingId(grv.id);
    try {
      if (action === "confirm") await api.post(`/grvs/${grv.id}/confirm`, {});
      if (action === "inspect") await api.post(`/grvs/${grv.id}/inspect`, {});
      if (action === "cancel") {
        const reason = window.prompt("Why are you cancelling this unconfirmed GRV?");
        if (reason === null) return;
        if (!reason.trim()) return toast.error("A cancellation reason is required");
        await api.post(`/grvs/${grv.id}/cancel`, { reason });
      }
      if (action === "reverse") {
        const reason = window.prompt("Enter the reason for reversing this confirmed GRV:");
        if (reason === null) return;
        if (!reason.trim()) return toast.error("A reversal reason is required");
        await api.post(`/grvs/${grv.id}/reverse`, { reason });
      }
      toast.success(action === "confirm" ? "GRV confirmed and accepted quantities added to Stock" : `GRV ${action} completed`);
      await refresh();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWorkingId("");
    }
  };

  const exportPdf = async (grv) => {
    try {
      await downloadGRVPdf(grv, dashboard?.company_profile_name || companyProfileName(companyId), settings);
    } catch (error) {
      toast.error(`Could not create GRV PDF: ${error.message || "Unknown error"}`);
    }
  };

  const metricCards = [
    ["Total GRVs", dashboard?.total_grvs, FileText, "text-slate-900"],
    ["Pending GRVs", dashboard?.pending_grvs, Clock3, "text-blue-700"],
    ["Completed GRVs", dashboard?.completed_grvs, PackageCheck, "text-emerald-700"],
    ["Partially Received", dashboard?.partially_received_grvs, ClipboardCheck, "text-amber-700"],
    ["Discrepancies", dashboard?.discrepancy_grvs, ShieldAlert, "text-red-700"],
    ["Rejected Items", dashboard?.rejected_items, Ban, "text-orange-700"],
  ];

  return (
    <div className="space-y-5" data-testid="grv-page">
      <PageHeader title="Goods Received Vouchers" subtitle="Inspect supplier deliveries and post accepted quantities to Stock">
        <Btn variant="outline" onClick={refresh} disabled={records === null} data-testid="grv-refresh"><RefreshCw size={16} /> Refresh</Btn>
        <Btn onClick={() => setDraft({ ...blankGRV(), received_by: user?.name || user?.email || "" })} data-testid="grv-create"><Plus size={16} /> Create GRV</Btn>
      </PageHeader>

      <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="grv-active-company">
        <Building2 size={17} className="text-primary" />
        <span className="text-sm font-semibold text-slate-700">Active company profile:</span>
        <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">{dashboard?.company_profile_name || companyProfileName(companyId)}</Badge>
        <span className="text-xs text-slate-500">GRVs, suppliers, purchase orders and stock are isolated to this profile.</span>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {metricCards.map(([label, value, icon, tone]) => <Metric key={label} label={label} value={value} icon={icon} tone={tone} />)}
      </div>

      <Card className="overflow-hidden" data-testid="grv-recent">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-slate-800">Recently Created GRVs</h2>
          <p className="text-xs text-slate-500">Latest vouchers for the active company profile</p>
        </div>
        {!dashboard?.recent_grvs?.length
          ? <p className="p-4 text-sm text-slate-500">No recent GRVs match these filters.</p>
          : <div className="divide-y divide-border/70">
            {dashboard.recent_grvs.slice(0, 5).map((grv) => (
              <div key={grv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-testid={`grv-recent-${grv.id}`}>
                <div><p className="text-sm font-semibold text-slate-800">{grv.grv_number} · {grv.supplier_name}</p><p className="text-xs text-slate-500">{fmtDate(grv.received_date)} · {grv.purchase_order_reference || "Standalone receipt"}</p></div>
                <Badge cls={STATUS_STYLE[grv.status] || STATUS_STYLE.draft}>{statusLabel(grv.status)}</Badge>
              </div>
            ))}
          </div>}
      </Card>

      <Card className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="grv-filters">
        <Input label="Received from" type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} data-testid="grv-date-from" />
        <Input label="Received to" type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} data-testid="grv-date-to" />
        <Select label="Supplier" value={filters.supplier_id} onChange={(event) => setFilters({ ...filters, supplier_id: event.target.value })} data-testid="grv-supplier-filter">
          <option value="">All suppliers</option>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
        </Select>
        <Select label="Company profile" value={companyId} disabled data-testid="grv-profile-filter">
          <option value={companyId}>{dashboard?.company_profile_name || companyProfileName(companyId)}</option>
        </Select>
        <Select label="Status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })} data-testid="grv-status-filter">
          <option value="">All statuses</option>
          {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </Card>

      <Card className="overflow-hidden" data-testid="grv-list">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-semibold text-slate-800">GRV Register</h2>
            <p className="text-xs text-slate-500">Accepted stock value in this view: {fmtMoney(totalValue)}</p>
          </div>
          <span className="text-xs text-slate-500">{records?.length ?? 0} records</span>
        </div>
        {records === null ? <p className="p-6 text-sm text-slate-400" role="status">Loading GRVs...</p> : records.length === 0 ? (
          <Empty icon={ClipboardCheck} title="No GRVs found" hint="Create a goods received voucher for a supplier delivery." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead><tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-4 py-3">GRV number</th><th className="px-4 py-3">Received date</th>
                <th className="px-4 py-3">Supplier</th><th className="px-4 py-3">PO / delivery note</th>
                <th className="px-4 py-3 text-right">Lines</th><th className="px-4 py-3 text-right">Accepted value</th>
                <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>{records.map((grv) => {
                const value = (grv.items || []).reduce((sum, line) => sum + Number(line.total_value || 0), 0);
                const busy = workingId === grv.id;
                const confirmed = ["completed", "partially_received", "discrepancy", "reversing"].includes(grv.status);
                return (
                  <tr key={grv.id} className="border-b border-border/60 align-top hover:bg-slate-50" data-testid={`grv-row-${grv.id}`}>
                    <td className="px-4 py-3 font-semibold text-primary">{grv.grv_number}</td>
                    <td className="px-4 py-3">{fmtDate(grv.received_date)}</td>
                    <td className="px-4 py-3">{grv.supplier_name || "-"}</td>
                    <td className="px-4 py-3"><span className="block">{grv.purchase_order_reference || "Standalone"}</span><span className="text-xs text-slate-500">{grv.delivery_note_number || "No delivery note"}</span></td>
                    <td className="px-4 py-3 text-right font-mono">{grv.items?.length || 0}</td>
                    <td className="px-4 py-3 text-right font-mono">{fmtMoney(value)}</td>
                    <td className="px-4 py-3"><Badge cls={STATUS_STYLE[grv.status] || STATUS_STYLE.draft}>{statusLabel(grv.status)}</Badge></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button type="button" onClick={() => exportPdf(grv)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="Download GRV PDF" aria-label={`Download PDF ${grv.grv_number}`} data-testid={`grv-pdf-${grv.id}`}><Download size={16} /></button>
                        {grv.status === "draft" && <button type="button" onClick={() => setDraft({ ...grv, received_by: grv.received_by || "" })} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="Edit draft" aria-label={`Edit ${grv.grv_number}`} data-testid={`grv-edit-${grv.id}`}><Pencil size={15} /></button>}
                        {grv.status === "draft" && <button type="button" onClick={() => act(grv, "inspect")} disabled={busy} className="rounded px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50" data-testid={`grv-inspect-${grv.id}`}>Inspect</button>}
                        {["draft", "pending_inspection", "confirming"].includes(grv.status) && <button type="button" onClick={() => act(grv, "confirm", `Confirm ${grv.grv_number}? Accepted quantities will be posted to Stock once.`)} disabled={busy} className="rounded px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50" data-testid={`grv-confirm-${grv.id}`}>{busy ? "Working..." : grv.status === "confirming" ? "Retry confirm" : "Confirm"}</button>}
                        {["draft", "pending_inspection"].includes(grv.status) && <button type="button" onClick={() => act(grv, "cancel")} disabled={busy} className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700" title="Cancel draft" data-testid={`grv-cancel-${grv.id}`}><Ban size={15} /></button>}
                        {confirmed && (user?.is_admin || user?.is_owner) && <button type="button" onClick={() => act(grv, "reverse", `Reverse ${grv.grv_number}? This adds traceable stock reversals and reopens its PO quantities when possible.`)} disabled={busy} className="rounded p-1.5 text-red-700 hover:bg-red-50 disabled:opacity-50" title="Reverse confirmed GRV" data-testid={`grv-reverse-${grv.id}`}><RotateCcw size={15} /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-500">GRVs are receiving documents only. They do not create supplier payments, expenses or Buying records. Document file attachments are not enabled in this deployment; delivery note numbers and notes remain available.</p>

      <Modal open={!!draft} onClose={() => !saving && setDraft(null)} title={draft?.id ? `Edit ${draft.grv_number}` : "Create Goods Received Voucher"} wide>
        {draft && <form onSubmit={saveDraft} className="space-y-4 p-1">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select label="Purchase order (optional)" value={draft.purchase_order_id} onChange={(event) => chooseOrder(event.target.value)} data-testid="grv-po-select">
              <option value="">Standalone GRV</option>
              {orders.map((order) => <option key={order.id} value={order.id}>{order.reference} · {order.supplier_name}</option>)}
            </Select>
            {draft.purchase_order_id
              ? <Input label="Supplier" value={draft.supplier_name} readOnly data-testid="grv-supplier-name" />
              : <Select label="Supplier *" value={draft.supplier_id} onChange={(event) => {
                const supplier = suppliers.find((item) => item.id === event.target.value);
                setDraft({ ...draft, supplier_id: event.target.value, supplier_name: supplier?.name || "" });
              }} data-testid="grv-supplier-select">
                <option value="">Select supplier</option>
                {suppliers.filter((supplier) => supplier.active !== false).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </Select>}
            <Input label="Received date *" type="date" value={draft.received_date} onChange={(event) => setDraft({ ...draft, received_date: event.target.value })} required data-testid="grv-received-date" />
            <Input label="Delivery note number" value={draft.delivery_note_number} onChange={(event) => setDraft({ ...draft, delivery_note_number: event.target.value })} data-testid="grv-delivery-note" />
            <Input label="Received by" value={draft.received_by} onChange={(event) => setDraft({ ...draft, received_by: event.target.value })} data-testid="grv-received-by" />
            <Input label="Warehouse" value={draft.warehouse} onChange={(event) => setDraft({ ...draft, warehouse: event.target.value })} data-testid="grv-warehouse" />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1100px] text-xs">
              <thead><tr className="bg-slate-50 text-left text-slate-500">
                <th className="p-2">Product / size</th><th className="p-2 text-right">Ordered</th>
                <th className="p-2 text-right">Previously received</th><th className="p-2 text-right">Remaining</th>
                <th className="p-2 text-right">Actually received</th><th className="p-2 text-right">Accepted</th>
                <th className="p-2 text-right">Rejected</th><th className="p-2 text-right">Damaged</th>
                <th className="p-2 text-right">Unit cost</th><th className="p-2 text-right">Total value</th>
                {!draft.purchase_order_id && <th className="p-2"> </th>}
              </tr></thead>
              <tbody>{draft.items.map((line, index) => (
                <tr key={`${line.stock_id}-${index}`} className="border-t border-border/70">
                  <td className="p-2">
                    {!draft.purchase_order_id
                      ? <Select aria-label="Stock product" value={line.stock_id} onChange={(event) => chooseStock(index, event.target.value)} data-testid={`grv-stock-${index}`}>
                        <option value="">Select stock item</option>
                        {stock.map((item) => <option key={item.id} value={item.id}>{item.product} · {item.size}</option>)}
                      </Select>
                      : <><span className="block font-semibold text-slate-800">{line.product}</span><span className="text-slate-500">{line.size} · {line.product_code}</span></>}
                  </td>
                  {[["ordered_quantity", line.ordered_quantity], ["previously_received_quantity", line.previously_received_quantity], ["remaining_quantity", line.remaining_quantity]].map(([key, value]) => (
                    <td key={key} className="p-2 text-right font-mono">{value || 0}</td>
                  ))}
                  {[
                    ["actual_received_quantity", line.actual_received_quantity],
                    ["accepted_quantity", line.accepted_quantity],
                    ["rejected_quantity", line.rejected_quantity],
                    ["damaged_quantity", line.damaged_quantity],
                    ["unit_cost", line.unit_cost],
                  ].map(([key, value]) => (
                    <td key={key} className="p-2">
                      <input type="number" min="0" step={key === "unit_cost" ? "0.01" : "0.01"} value={value}
                        onChange={(event) => updateLine(index, key, Number(event.target.value))}
                        aria-label={`${key.replaceAll("_", " ")} line ${index + 1}`}
                        className="w-24 rounded border border-input px-2 py-1.5 text-right font-mono"
                        data-testid={`grv-${key}-${index}`} />
                    </td>
                  ))}
                  <td className="p-2 text-right font-mono font-semibold">{fmtMoney(lineValue(line))}</td>
                  {!draft.purchase_order_id && <td className="p-2"><button type="button" onClick={() => setDraft({ ...draft, items: draft.items.filter((_, row) => row !== index) })} className="text-xs text-red-700 hover:underline">Remove</button></td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!draft.purchase_order_id && <Btn type="button" variant="outline" onClick={() => setDraft({ ...draft, items: [...draft.items, blankLine()] })}><Plus size={14} /> Add product line</Btn>}
          <Textarea label="Notes / discrepancies" rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} data-testid="grv-notes" />
          <p className="rounded-md bg-blue-50 p-3 text-xs text-blue-800">This saves a draft only. Confirming posts accepted quantities to Stock and updates the linked purchase order once. Rejected and damaged quantities are excluded from available stock.</p>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => setDraft(null)} disabled={saving}>Cancel</Btn>
            <Btn type="submit" disabled={saving} data-testid="grv-save-draft">{saving ? "Saving..." : draft.id ? "Save changes" : "Save GRV draft"}</Btn>
          </div>
        </form>}
      </Modal>
    </div>
  );
}
