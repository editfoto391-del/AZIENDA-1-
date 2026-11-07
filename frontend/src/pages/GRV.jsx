import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Ban, Building2, ClipboardCheck, Clock3, Download, FileText, PackageCheck,
  Pencil, Plus, RefreshCw, RotateCcw, ScanLine, ShieldAlert, Trash2,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtMoney, today } from "@/lib/format";
import { companyProfileName } from "@/lib/company";
import { updateGrvReceivedQuantity } from "@/lib/grv.mjs";
import { Badge, Btn, Card, Empty, Input, Modal, PageHeader, Select, Textarea } from "@/components/common";
import BarcodeScanner from "@/components/BarcodeScanner";

const STATUSES = [
  ["draft", "Draft"],
  ["pending_inspection", "Pending Inspection"],
  ["partially_received", "Partially Received"],
  ["completed", "Completed"],
  ["discrepancy", "Discrepancy"],
  ["cancelled", "Cancelled"],
];
const DELETABLE_GRV_STATUSES = new Set(["draft", "pending_inspection", "cancelled"]);
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
  stock_id: "", product_code: "", new_product: false, product: "", size: "",
  purchase_order_item_index: null, ordered_quantity: 0,
  previously_received_quantity: 0, remaining_quantity: 0,
  actual_received_quantity: 0, accepted_quantity: 0, rejected_quantity: 0,
  damaged_quantity: 0, unit_cost: 0, sale_price_zone_1: "", sale_price_zone_2: "",
  total_value: 0,
});
const blankGRV = () => ({
  supplier_id: "", supplier_name: "", purchase_order_id: "",
  delivery_note_number: "", received_date: today(), received_by: "",
  warehouse: "", notes: "", items: [blankLine()],
  purpose: "selling", is_chemical: false,
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
  const showZone2 = /super/i.test(companyName || settings.company_name || "")
    && /iq.*foam/i.test(companyName || settings.company_name || "");
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
    { title: "Product / size", x: margin, width: 32, align: "left" },
    { title: "Ordered", x: 49, width: 15, align: "right" },
    { title: "Received", x: 66, width: 15, align: "right" },
    { title: "Accepted", x: 83, width: 15, align: "right" },
    { title: "Rejected", x: 100, width: 15, align: "right" },
    { title: "Buy", x: 117, width: 17, align: "right" },
    { title: "Sell Z1", x: 135, width: 17, align: "right" },
    ...(showZone2 ? [{ title: "Sell Z2", x: 153, width: 17, align: "right" }] : []),
    { title: "Value", x: right - 22, width: 22, align: "right" },
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
      line.sale_price_zone_1 == null ? "-" : fmtMoney(line.sale_price_zone_1),
      ...(showZone2 ? [line.sale_price_zone_2 == null ? "-" : fmtMoney(line.sale_price_zone_2)] : []),
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
  const isSuperIQFoam = companyId === "superiqfoam";
  const salePriceFields = isSuperIQFoam
    ? [
      ["sale_price_zone_1", "Sale price · Zone 1"],
      ["sale_price_zone_2", "Sale price · Zone 2"],
    ]
    : [["sale_price_zone_1", "Selling price"]];
  const [dashboard, setDashboard] = useState(null);
  const [records, setRecords] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stock, setStock] = useState([]);
  const [stockSearchByLine, setStockSearchByLine] = useState({});
  const [settings, setSettings] = useState({});
  const [filters, setFilters] = useState({ date_from: "", date_to: "", supplier_id: "", status: "" });
  const [draft, setDraft] = useState(null);
  const [scanReceivingMode, setScanReceivingMode] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectedGRVIds, setSelectedGRVIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState("");
  const canDeleteGRVs = !!(user?.is_owner || user?.is_company_owner);

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
    // Load each list independently so one failing request does not leave the suppliers empty.
    const load = (path, apply) => api.get(path).then(apply).catch((error) => toast.error(apiError(error)));
    load("/suppliers", (list) => setSuppliers(list || []));
    load("/grvs/purchase-orders", (list) => setOrders(list || []));
    load("/stock", (list) => setStock(list || []));
    load("/settings", (value) => setSettings(value || {}));
  }, [companyId]);

  const totalValue = useMemo(
    () => (records || []).reduce((sum, grv) =>
      sum + (grv.items || []).reduce((lineSum, line) => lineSum + Number(line.total_value || 0), 0), 0),
    [records],
  );
  const selectableGRVs = useMemo(
    () => (records || []).filter((grv) => DELETABLE_GRV_STATUSES.has(grv.status)),
    [records],
  );
  const allVisibleGRVsSelected = selectableGRVs.length > 0
    && selectableGRVs.every((grv) => selectedGRVIds.includes(grv.id));

  useEffect(() => {
    setSelectedGRVIds([]);
  }, [companyId, filters]);

  const updateLine = (index, key, value) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((line, lineIndex) => lineIndex === index
        ? key === "actual_received_quantity"
          ? updateGrvReceivedQuantity(line, value)
          : { ...line, [key]: value }
        : line),
    }));
  };

  const updateStockSearch = (index, value) => {
    setStockSearchByLine((current) => ({ ...current, [index]: value }));
  };

  const removeLine = (index) => {
    setDraft((current) => ({ ...current, items: current.items.filter((_, row) => row !== index) }));
    setStockSearchByLine((current) => Object.fromEntries(
      Object.entries(current)
        .filter(([lineIndex]) => Number(lineIndex) !== index)
        .map(([lineIndex, value]) => [Number(lineIndex) > index ? Number(lineIndex) - 1 : Number(lineIndex), value]),
    ));
  };

  const chooseOrder = (orderId) => {
    if (!orderId) {
      setStockSearchByLine({});
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
    setStockSearchByLine({});
  };

  const chooseStock = (index, stockId) => {
    updateStockSearch(index, "");
    if (stockId === "__new_product__") {
      setDraft((current) => ({
        ...current,
        items: current.items.map((line, lineIndex) => lineIndex === index
          ? {
            ...line, stock_id: "", product_code: "", new_product: true,
            product: "", size: "", sale_price_zone_1: "", sale_price_zone_2: "",
          }
          : line),
      }));
      return;
    }
    const selected = stock.find((item) => item.id === stockId);
    if (!selected) {
      setDraft((current) => ({
        ...current,
        items: current.items.map((line, lineIndex) => lineIndex === index
          ? { ...line, stock_id: "", new_product: false }
          : line),
      }));
      return;
    }
    setDraft((current) => ({
      ...current,
      items: current.items.map((line, lineIndex) => lineIndex === index
        ? {
          ...line,
          stock_id: selected.id,
          new_product: false,
          product_code: selected.code || selected.sku || selected.id,
          product: selected.product,
          size: selected.size || "",
          unit_cost: Number(selected.unit_cost || 0),
        }
        : line),
    }));
  };

  const scanGRVProduct = async (code) => {
    try {
      const product = await api.post("/products/scan", {
        code,
        scan_id: globalThis.crypto?.randomUUID?.(),
      });
      if (draft.purchase_order_id && !draft.items.some((line) => line.stock_id === product.stock_id)) {
        toast.error(`${product.product} · ${product.dimensions} is not part of this purchase order`);
        return;
      }
      setDraft((current) => {
        if (!current) return current;
        const items = [...current.items];
        let lineIndex = items.findIndex((line) => line.stock_id === product.stock_id);
        if (lineIndex < 0) {
          lineIndex = items.findIndex((line) => !line.stock_id);
          if (lineIndex < 0) {
            lineIndex = items.length;
            items.push(blankLine());
          }
          const selectedStock = stock.find((item) => item.id === product.stock_id);
          items[lineIndex] = {
            ...items[lineIndex],
            stock_id: product.stock_id,
            product_code: product.product_id,
            product: product.product,
            size: product.dimensions,
            unit_cost: scanReceivingMode ? "" : Number(selectedStock?.unit_cost || 0),
          };
        }
        const line = items[lineIndex];
        items[lineIndex] = {
          ...line,
          actual_received_quantity: Number(line.actual_received_quantity || 0) + 1,
          accepted_quantity: Number(line.accepted_quantity || 0) + 1,
        };
        return { ...current, items };
      });
      toast.success(`${product.product} · ${product.dimensions} received quantity increased`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const deleteGRV = async (event) => {
    event.preventDefault();
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.delWithData(`/grvs/${deleteTarget.id}`, {});
      const deleted = deleteTarget;
      setRecords((current) => current?.filter((grv) => grv.id !== deleted.id) ?? current);
      setSelectedGRVIds((current) => current.filter((id) => id !== deleted.id));
      toast.success(`${deleteTarget.grv_number} deleted`);
      setDeleteTarget(null);
      const query = {
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
        company_profile_id: companyId,
      };
      api.get("/grvs/dashboard", query).then(setDashboard).catch((error) => {
        toast.error(`GRV deleted, but the summary could not be refreshed: ${apiError(error)}`);
      });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const deleteSelectedGRVs = async () => {
    if (!selectedGRVIds.length || deleteBusy) return;
    if (!window.confirm(`Permanently delete ${selectedGRVIds.length} selected GRV(s)? Confirmed GRVs must be reversed first.`)) return;
    setDeleteBusy(true);
    try {
      const result = await api.post("/grvs/bulk-delete", { ids: selectedGRVIds });
      const deletedIds = new Set((result.deleted || []).map((grv) => grv.id));
      setRecords((current) => current?.filter((grv) => !deletedIds.has(grv.id)) ?? current);
      setSelectedGRVIds([]);
      if (deletedIds.size) {
        toast.success(`${deletedIds.size} GRV${deletedIds.size === 1 ? "" : "s"} deleted`);
      }
      if (result.failed?.length) {
        toast.error(`${result.failed.length} GRV(s) not deleted: ${result.failed.map((item) => `${item.id}: ${item.message}`).join("; ")}`);
      }
      const query = {
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
        company_profile_id: companyId,
      };
      api.get("/grvs/dashboard", query).then(setDashboard).catch((error) => {
        toast.error(`GRVs deleted, but the summary could not be refreshed: ${apiError(error)}`);
      });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const deleteRequiresReversal = deleteTarget
    && !["draft", "pending_inspection", "cancelled"].includes(deleteTarget.status);

  const saveDraft = async (event) => {
    event.preventDefault();
    if (saving || !draft) return;
    if (!draft.supplier_id && !draft.supplier_name.trim()) return toast.error("Choose a supplier");
    const raw = draft.purpose === "raw_material";
    if (draft.items.some((line) => !Number(line.unit_cost)) && !window.confirm("Unit cost is missing on some lines. It is optional but recommended for accurate stock value. Save without it?")) return;
    if (!draft.items.length) return toast.error("Add at least one product line");
    if (!raw && draft.items.some((line) => line.new_product
      ? !(line.product || "").trim() || !(line.size || "").trim()
      : !line.stock_id)) {
      return toast.error("Select a stock product or enter a name and size for every new product");
    }
    if (raw && draft.items.some((line) => !(line.product || "").trim() || !(line.unit || "").trim())) return toast.error("Enter name and unit for every raw material");
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
          sale_price_zone_1: line.sale_price_zone_1 === "" || line.sale_price_zone_1 == null
            ? null : Number(line.sale_price_zone_1),
          sale_price_zone_2: line.sale_price_zone_2 === "" || line.sale_price_zone_2 == null
            ? null : Number(line.sale_price_zone_2),
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
      if (action === "confirm") {
        await api.post(`/grvs/${grv.id}/confirm`, {});
        toast.success("GRV confirmed and accepted quantities added to Stock");
        try {
          setStock(await api.getUncached("/stock"));
        } catch (error) {
          toast.error(`GRV confirmed, but current stock could not be refreshed: ${apiError(error)}`);
        }
        await refresh();
        return;
      }
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
      toast.success(`GRV ${action} completed`);
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
        <Btn onClick={() => {
          setScanReceivingMode(false);
          setStockSearchByLine({});
          setDraft({ ...blankGRV(), received_by: user?.name || user?.email || "" });
        }} data-testid="grv-create"><Plus size={16} /> Create GRV</Btn>
        <Btn variant="outline" onClick={() => {
          setScanReceivingMode(true);
          setStockSearchByLine({});
          setDraft({ ...blankGRV(), received_by: user?.name || user?.email || "" });
        }} data-testid="grv-quick-create"><ScanLine size={16} /> Quick GRV</Btn>
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
          <div className="flex items-center gap-3">
            {canDeleteGRVs && selectedGRVIds.length > 0 && <Btn
              variant="danger"
              onClick={deleteSelectedGRVs}
              disabled={deleteBusy}
              data-testid="grv-bulk-delete"
            >
              <Trash2 size={15} /> {deleteBusy ? "Deleting..." : `Delete selected (${selectedGRVIds.length})`}
            </Btn>}
            <span className="text-xs text-slate-500">{records?.length ?? 0} records</span>
          </div>
        </div>
        {records === null ? <p className="p-6 text-sm text-slate-400" role="status">Loading GRVs...</p> : records.length === 0 ? (
          <Empty icon={ClipboardCheck} title="No GRVs found" hint="Create a goods received voucher for a supplier delivery." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead><tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500">
                {canDeleteGRVs && <th className="px-3 py-3 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all deletable GRVs"
                    checked={allVisibleGRVsSelected}
                    disabled={!selectableGRVs.length || deleteBusy}
                    onChange={(event) => {
                      const visibleIds = new Set(selectableGRVs.map((grv) => grv.id));
                      setSelectedGRVIds((current) => event.target.checked
                        ? [...new Set([...current, ...visibleIds])]
                        : current.filter((id) => !visibleIds.has(id)));
                    }}
                    data-testid="grv-select-all"
                  />
                </th>}
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
                    {canDeleteGRVs && <td className="px-3 py-3 text-center">
                      {DELETABLE_GRV_STATUSES.has(grv.status) && <input
                        type="checkbox"
                        aria-label={`Select ${grv.grv_number} for deletion`}
                        checked={selectedGRVIds.includes(grv.id)}
                        disabled={deleteBusy}
                        onChange={(event) => setSelectedGRVIds((current) => event.target.checked
                          ? [...new Set([...current, grv.id])]
                          : current.filter((id) => id !== grv.id))}
                        data-testid={`grv-select-${grv.id}`}
                      />}
                    </td>}
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
                        {grv.status === "draft" && <button type="button" onClick={() => { setScanReceivingMode(false); setStockSearchByLine({}); setDraft({ ...grv, received_by: grv.received_by || "" }); }} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="Edit draft" aria-label={`Edit ${grv.grv_number}`} data-testid={`grv-edit-${grv.id}`}><Pencil size={15} /></button>}
                        {grv.status === "draft" && <button type="button" onClick={() => act(grv, "inspect")} disabled={busy} className="rounded px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50" data-testid={`grv-inspect-${grv.id}`}>Inspect</button>}
                        {["draft", "pending_inspection", "confirming"].includes(grv.status) && <button type="button" onClick={() => act(grv, "confirm", `Confirm ${grv.grv_number}? Accepted quantities will be posted to Stock once.`)} disabled={busy} className="rounded px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50" data-testid={`grv-confirm-${grv.id}`}>{busy ? "Working..." : grv.status === "confirming" ? "Retry confirm" : "Confirm"}</button>}
                        {["draft", "pending_inspection"].includes(grv.status) && <button type="button" onClick={() => act(grv, "cancel")} disabled={busy} className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700" title="Cancel draft" data-testid={`grv-cancel-${grv.id}`}><Ban size={15} /></button>}
                        {canDeleteGRVs && DELETABLE_GRV_STATUSES.has(grv.status) && <button type="button" onClick={() => setDeleteTarget(grv)} disabled={busy} className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700" title="Delete GRV" aria-label={`Delete ${grv.grv_number}`} data-testid={`grv-delete-${grv.id}`}><Trash2 size={15} /></button>}
                        {confirmed && (user?.is_admin || user?.is_owner) && <button type="button" onClick={() => act(grv, "reverse", `${grv.status === "reversing" ? "Retry" : "Reverse"} ${grv.grv_number}? This adds traceable stock reversals and reopens its PO quantities when possible.`)} disabled={busy} className="rounded p-1.5 text-red-700 hover:bg-red-50 disabled:opacity-50" title={grv.status === "reversing" ? "Retry GRV reversal" : "Reverse confirmed GRV"} data-testid={`grv-reverse-${grv.id}`}><RotateCcw size={15} /></button>}
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

      <Modal open={!!draft} onClose={() => !saving && setDraft(null)} title={draft?.id ? `Edit ${draft.grv_number}` : scanReceivingMode ? "Receive stock by scanning" : "Create Goods Received Voucher"} wide>
        {draft && <form onSubmit={saveDraft} className="space-y-4 p-1">
          {scanReceivingMode && <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            Scan a product to match its exact stock size, then enter the received quantity and optional unit cost. Save the GRV, then confirm it to post accepted quantities to stock.
          </p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {!scanReceivingMode && <Select label="Purchase order (optional)" value={draft.purchase_order_id} onChange={(event) => chooseOrder(event.target.value)} data-testid="grv-po-select">
              <option value="">Standalone GRV</option>
              {orders.map((order) => <option key={order.id} value={order.id}>{order.reference} · {order.supplier_name}</option>)}
            </Select>}
            {!scanReceivingMode && draft.purchase_order_id
              ? <Input label="Supplier" value={draft.supplier_name} readOnly data-testid="grv-supplier-name" />
              : <Select label="Supplier *" value={draft.supplier_id} onChange={(event) => {
                const supplier = suppliers.find((item) => item.id === event.target.value);
                setDraft({ ...draft, supplier_id: event.target.value, supplier_name: supplier?.name || "" });
              }} data-testid="grv-supplier-select">
                <option value="">Select supplier</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.active === false ? " (inactive)" : ""}</option>)}
              </Select>}
            {!scanReceivingMode && !draft.purchase_order_id && !draft.id && <Select label="GRV type *" value={draft.purpose} onChange={(event) => setDraft({ ...draft, purpose: event.target.value, is_chemical: false, items: [blankLine()] })} data-testid="grv-purpose">
              <option value="selling">Selling product (goes to Stock)</option>
              <option value="raw_material">Raw material (goes to Company Inventory)</option>
            </Select>}
            {draft.purpose === "raw_material" && <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={!!draft.is_chemical} disabled={!!draft.id} onChange={(event) => setDraft({ ...draft, is_chemical: event.target.checked })} data-testid="grv-is-chemical" />
              Chemical {["superiqfoam", "iqfoam-manufactoring"].includes(companyId) ? "(goes to Chemicals Quantity)" : "(goes to Company Inventory)"}
            </label>}
            <Input label="Received date *" type="date" value={draft.received_date} onChange={(event) => setDraft({ ...draft, received_date: event.target.value })} required data-testid="grv-received-date" />
            <Input label="Delivery note number" value={draft.delivery_note_number} onChange={(event) => setDraft({ ...draft, delivery_note_number: event.target.value })} data-testid="grv-delivery-note" />
            <Input label={scanReceivingMode ? "Scanned by *" : "Received by"} value={draft.received_by} onChange={(event) => setDraft({ ...draft, received_by: event.target.value })} required={scanReceivingMode} data-testid="grv-received-by" />
            <Input label="Warehouse" value={draft.warehouse} onChange={(event) => setDraft({ ...draft, warehouse: event.target.value })} data-testid="grv-warehouse" />
          </div>

          {scanReceivingMode && <div className="max-w-xl">
            <BarcodeScanner onScan={scanGRVProduct} disabled={saving} dedupeWindowMs={0} label="Scan product to match its stock size" />
          </div>}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className={`w-full ${scanReceivingMode ? "min-w-[1000px]" : isSuperIQFoam ? "min-w-[1250px]" : "min-w-[1100px]"} text-xs`}>
              <thead><tr className="bg-slate-50 text-left text-slate-500">
                <th className="p-2">Product / size</th>
                {scanReceivingMode
                  ? <><th className="p-2 text-right">Quantity received</th><th className="p-2 text-right">Purchase price</th>
                    {draft.purpose !== "raw_material" && salePriceFields.map(([key, label]) => <th key={key} className="p-2 text-right">{label}</th>)}
                    <th className="p-2 text-right">Total value</th><th className="p-2"> </th></>
                  : <><th className="p-2 text-right">Actually received</th><th className="p-2 text-right">Accepted</th>
                    <th className="p-2 text-right">Rejected</th><th className="p-2 text-right">Damaged</th>
                    <th className="p-2 text-right">Purchase price</th>
                    {draft.purpose !== "raw_material" && salePriceFields.map(([key, label]) => <th key={key} className="p-2 text-right">{label}</th>)}
                    <th className="p-2 text-right">Total value</th>
                    {!draft.purchase_order_id && <th className="p-2"> </th>}</>}
              </tr></thead>
              <tbody>{draft.items.map((line, index) => (
                <tr key={`${line.stock_id}-${index}`} className="border-t border-border/70">
                  <td className="p-2">
                    {scanReceivingMode
                      ? <><span className="block font-semibold text-slate-800">{line.product || "Scan a product"}</span><span className="text-slate-500">{line.size}{line.product_code ? ` · ${line.product_code}` : ""}</span></>
                      : draft.purpose === "raw_material"
                      ? <div className="grid min-w-[360px] grid-cols-2 gap-1">
                        <input placeholder="Name *" value={line.product} onChange={(event) => updateLine(index, "product", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-raw-name-${index}`} />
                        {draft.is_chemical
                          ? <input placeholder="Container (Barrel...)" value={line.container_type || ""} onChange={(event) => updateLine(index, "container_type", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-raw-container-${index}`} />
                          : <input placeholder="Category (Glue, Tape...)" value={line.category || ""} onChange={(event) => updateLine(index, "category", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-raw-category-${index}`} />}
                        <input placeholder={draft.is_chemical ? "Capacity (number)" : "Size"} value={line.size} onChange={(event) => updateLine(index, "size", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-raw-size-${index}`} />
                        <input placeholder="Unit * (kg, L, pcs)" value={line.unit || ""} onChange={(event) => updateLine(index, "unit", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-raw-unit-${index}`} />
                      </div>
                      : !draft.purchase_order_id
                      ? line.new_product
                      ? <div className="grid min-w-[360px] grid-cols-2 gap-1">
                        <input placeholder="New product / category *" value={line.product} onChange={(event) => updateLine(index, "product", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-new-product-name-${index}`} />
                        <input placeholder="Size / measurement *" value={line.size} onChange={(event) => updateLine(index, "size", event.target.value)} className="rounded border border-input px-2 py-1.5" data-testid={`grv-new-product-size-${index}`} />
                        <button type="button" onClick={() => chooseStock(index, "")} className="col-span-2 text-left text-xs text-primary hover:underline" data-testid={`grv-select-existing-product-${index}`}>Choose an existing stock product instead</button>
                      </div>
                      : <div className="min-w-[220px] space-y-1.5" data-testid={`grv-stock-${index}`}>
                        <input
                          type="search"
                          aria-label="Search stock products"
                          placeholder="Type product, size or code..."
                          value={stockSearchByLine[index] || ""}
                          onChange={(event) => updateStockSearch(index, event.target.value)}
                          className="w-full rounded border border-input px-2 py-1.5"
                          data-testid={`grv-stock-search-${index}`}
                        />
                        {line.stock_id && !stockSearchByLine[index] && <span className="block text-xs text-slate-600">
                          Selected: {line.product} · {line.size}
                        </span>}
                        {stockSearchByLine[index]?.trim() && (() => {
                          const query = stockSearchByLine[index].trim().toLowerCase();
                          const matches = stock.filter((item) =>
                            [item.product, item.size, item.code, item.sku, item.id]
                              .some((value) => String(value || "").toLowerCase().includes(query))
                          );
                          return matches.length
                            ? <div className="max-h-40 overflow-y-auto rounded border border-border bg-white shadow-sm" role="listbox" aria-label="Stock search results">
                              {matches.slice(0, 20).map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  role="option"
                                  aria-selected={line.stock_id === item.id}
                                  onClick={() => chooseStock(index, item.id)}
                                  className="block w-full border-b border-border/60 px-2 py-1.5 text-left text-xs last:border-0 hover:bg-primary/5"
                                  data-testid={`grv-stock-result-${index}-${item.id}`}
                                >
                                  <span className="block font-semibold text-slate-800">{item.product} · {item.size}</span>
                                  {(item.code || item.sku) && <span className="text-slate-500">{item.code || item.sku}</span>}
                                </button>
                              ))}
                              {matches.length > 20 && <span className="block px-2 py-1 text-xs text-slate-500">Showing first 20 results. Refine your search.</span>}
                            </div>
                            : <span className="text-xs text-slate-500">No stock item matches that search.</span>;
                        })()}
                        <button
                          type="button"
                          onClick={() => chooseStock(index, "__new_product__")}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm font-bold text-primary transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                          data-testid={`grv-create-stock-product-${index}`}
                        ><Plus size={15} /> Create new product / category</button>
                      </div>
                      : <><span className="block font-semibold text-slate-800">{line.product}</span><span className="text-slate-500">{line.size} · {line.product_code}</span></>}
                  </td>
                  {scanReceivingMode ? <>
                    <td className="p-2">
                      <input type="number" min="0" step="0.01" value={line.actual_received_quantity}
                        onChange={(event) => {
                          const quantity = Number(event.target.value);
                          setDraft((current) => ({
                            ...current,
                            items: current.items.map((item, lineIndex) => lineIndex === index
                              ? { ...item, actual_received_quantity: quantity, accepted_quantity: quantity }
                              : item),
                          }));
                        }}
                        aria-label={`Quantity received line ${index + 1}`}
                        className="w-24 rounded border border-input px-2 py-1.5 text-right font-mono"
                        data-testid={`grv-quick-quantity-${index}`} />
                    </td>
                    <td className="p-2">
                      <input type="number" min="0" step="0.01" value={line.unit_cost}
                        onChange={(event) => updateLine(index, "unit_cost", event.target.value)}
                        aria-label={`Purchase price line ${index + 1}`}
                        className="w-28 rounded border border-input px-2 py-1.5 text-right font-mono"
                        data-testid={`grv-quick-unit-cost-${index}`} />
                    </td>
                    {draft.purpose !== "raw_material" && salePriceFields.map(([key, label]) => (
                      <td key={key} className="p-2">
                        <input type="number" min="0" step="0.01" value={line[key] ?? ""}
                          onChange={(event) => updateLine(index, key, event.target.value)}
                          aria-label={`${label} line ${index + 1}`}
                          className="w-28 rounded border border-input px-2 py-1.5 text-right font-mono"
                          data-testid={`grv-quick-${key}-${index}`} />
                      </td>
                    ))}
                    <td className="p-2 text-right font-mono font-semibold">{fmtMoney(lineValue(line))}</td>
                    <td className="p-2"><button type="button" onClick={() => removeLine(index)} className="text-xs text-red-700 hover:underline">Remove</button></td>
                  </> : <>
                    {[
                      ["actual_received_quantity", line.actual_received_quantity],
                      ["accepted_quantity", line.accepted_quantity],
                      ["rejected_quantity", line.rejected_quantity],
                      ["damaged_quantity", line.damaged_quantity],
                    ].map(([key, value]) => (
                      <td key={key} className="p-2">
                        <input type="number" min="0" step="0.01" value={value}
                          onChange={(event) => updateLine(index, key, Number(event.target.value))}
                          aria-label={`${key.replaceAll("_", " ")} line ${index + 1}`}
                          className="w-24 rounded border border-input px-2 py-1.5 text-right font-mono"
                          data-testid={`grv-${key}-${index}`} />
                      </td>
                    ))}
                    <td className="p-2">
                      <input type="number" min="0" step="0.01" value={line.unit_cost}
                        onChange={(event) => updateLine(index, "unit_cost", Number(event.target.value))}
                        aria-label={`Purchase price line ${index + 1}`}
                        className="w-24 rounded border border-input px-2 py-1.5 text-right font-mono"
                        data-testid={`grv-unit-cost-${index}`} />
                    </td>
                    {draft.purpose !== "raw_material" && salePriceFields.map(([key, label]) => (
                      <td key={key} className="p-2">
                        <input type="number" min="0" step="0.01" value={line[key] ?? ""}
                          onChange={(event) => updateLine(index, key, event.target.value)}
                          aria-label={`${label} line ${index + 1}`}
                          className="w-24 rounded border border-input px-2 py-1.5 text-right font-mono"
                          data-testid={`grv-${key}-${index}`} />
                      </td>
                    ))}
                    <td className="p-2 text-right font-mono font-semibold">{fmtMoney(lineValue(line))}</td>
                    {!draft.purchase_order_id && <td className="p-2"><button type="button" onClick={() => removeLine(index)} className="text-xs text-red-700 hover:underline">Remove</button></td>}
                  </>}
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!draft.purchase_order_id && <Btn type="button" variant="outline" onClick={() => setDraft({ ...draft, items: [...draft.items, blankLine()] })}><Plus size={14} /> Add product line</Btn>}
          <Textarea label="Notes / discrepancies" rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} data-testid="grv-notes" />
          <p className="rounded-md bg-blue-50 p-3 text-xs text-blue-800">This saves a draft only. Confirming posts accepted quantities to Stock and updates the linked purchase order once. A new product/category is created in Stock on confirmation and needs a selling price for each applicable zone to appear on invoices. Entered selling prices update the price list; a worker must have a company owner confirm a GRV that changes prices. Reversing a GRV does not revert those prices. Rejected and damaged quantities are excluded from available stock.</p>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => setDraft(null)} disabled={saving}>Cancel</Btn>
            <Btn type="submit" disabled={saving} data-testid="grv-save-draft">{saving ? "Saving..." : draft.id ? "Save changes" : "Save GRV draft"}</Btn>
          </div>
        </form>}
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => !deleteBusy && setDeleteTarget(null)} title="Delete GRV">
        {deleteTarget && <form onSubmit={deleteGRV} className="space-y-4">
          <p className="text-sm text-slate-700">
            Permanently delete <span className="font-semibold">{deleteTarget.grv_number}</span>? This cannot be undone.
            {deleteRequiresReversal && " This GRV has affected stock. Use Reverse first, then delete it to preserve the stock history."}
          </p>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Cancel</Btn>
            <Btn type="submit" variant="danger" disabled={deleteBusy || deleteRequiresReversal} data-testid="grv-delete-confirm">
              {deleteBusy ? "Deleting..." : "Delete GRV"}
            </Btn>
          </div>
        </form>}
      </Modal>
    </div>
  );
}
