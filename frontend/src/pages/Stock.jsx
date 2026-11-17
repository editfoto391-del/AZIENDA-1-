import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { api, apiError } from "@/lib/api";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { companyProfileName, usesPriceZones, usesUnifiedPriceList } from "@/lib/company";
import { useAuth } from "@/context/AuthContext";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Boxes, Plus, ArrowUpDown, History, Undo2, Trash2, Search, X, ChevronDown, ChevronUp, Download } from "lucide-react";
import { listViewState, loadListRequest } from "@/lib/listRequest.mjs";
import { PRODUCT_RANGE_SECTIONS, REPORT_PRODUCT_NAMES, normalizeReportValue } from "@/lib/stockRangeReport.mjs";
import { drawStockRangeReportPdf } from "@/lib/stockRangeReportPdf.mjs";
import { canonicalStockProduct, deduplicateStockRows, normalizeStockLabel, uniqueStockCategories } from "@/lib/stockCatalog.mjs";

const ProductIdentificationManager = lazy(() => import("@/components/ProductIdentificationManager"));

const MOVE_TYPES = [
  { v: "adjustment_in", l: "Manual Adjustment In (+)" },
  { v: "return", l: "Return (+)" },
  { v: "adjustment_out", l: "Manual Adjustment Out (-)" },
  { v: "damage", l: "Damage / Waste (-)" },
];
const TYPE_LABEL = { production: "Production Received", production_consumption: "Production Material Used", purchase: "Purchase Received", dispatch: "Delivery Dispatched", invoice: "Invoice Submitted", adjustment_in: "Adjustment In", adjustment_out: "Adjustment Out", return: "Return", damage: "Damage/Waste", reversal: "Reversal" };
const sign = (m) => (m.direction ? m.direction : ["production", "purchase", "adjustment_in", "return"].includes(m.type) ? 1 : -1);
const STOCK_CATEGORY = {
  "Ribbon Black": ["Ribbon Black", "Ribbon Balck", "Black"],
  "Ribbon Balck": ["Ribbon Black", "Black"],
  "Ribbon Pink": ["Ribbon Pink", "Ribbon"],
};
export default function Stock() {
  const { user } = useAuth();
  const canViewStockCosts = user?.is_owner || user?.is_company_owner || user?.role === "owner";
  const isSuperIqFoam = user?.company_id === "superiqfoam";
  const reduceMotion = useReducedMotion();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const priceZonesEnabled = usesPriceZones(user?.company_id);
  const [list, setList] = useState(null);
  const [prices, setPrices] = useState([]);
  const [costDrafts, setCostDrafts] = useState({});
  const [category, setCategory] = useState("");
  const [stockSearch, setStockSearch] = useState("");
  const [showStockSearch, setShowStockSearch] = useState(false);
  const [showStockTotals, setShowStockTotals] = useState(true);
  const [movementRequest, setMovementRequest] = useState({ items: [], loading: true, error: "" });
  const [addModal, setAddModal] = useState(null);
  const [moveModal, setMoveModal] = useState(null);
  const [showHist, setShowHist] = useState(false);
  const [showProductIds, setShowProductIds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updatingRightStock, setUpdatingRightStock] = useState(false);
  const [dailyCountSheet, setDailyCountSheet] = useState(null);
  const [loadingDailyCount, setLoadingDailyCount] = useState(false);
  const [downloadingRangeReport, setDownloadingRangeReport] = useState(false);
  const [valueZone, setValueZone] = useState(1);

  const loadMovements = () => loadListRequest({
    request: () => api.get("/stock/movements"),
    setState: setMovementRequest,
    errorMessage: apiError,
  });

  const load = () => {
    api.get("/stock").then(setList).catch((e) => { toast.error(apiError(e)); setList([]); });
    api.get("/prices").then(setPrices).catch((e) => toast.error(apiError(e)));
    if (showHist) void loadMovements();
  };
  useEffect(() => { load(); }, []);

  const run = async (fn, ok) => {
    if (busy) return; setBusy(true);
    try { await fn(); toast.success(ok); load(); return true; } catch (e) { toast.error(apiError(e)); return false; } finally { setBusy(false); }
  };

  // One row per product+size (latest record), so duplicate legacy rows are not counted twice.
  const canonicalStock = deduplicateStockRows(list || [], STOCK_CATEGORY);
  const stockCategories = uniqueStockCategories(list || [], STOCK_CATEGORY);
  const getCanonicalStock = () => canonicalStock;
  const filteredList = canonicalStock.filter((item) =>
    (!category || normalizeStockLabel(canonicalStockProduct(item.product)) === normalizeStockLabel(canonicalStockProduct(category)))
    && (!stockSearch.trim() || `${item.product} ${item.size}`.toLowerCase().includes(stockSearch.trim().toLowerCase()))
  );
  const getRangeReportQuantity = (group, size) => {
    const names = REPORT_PRODUCT_NAMES[group];
    const matches = canonicalStock.filter((item) =>
      names.has(normalizeReportValue(item.product))
      && normalizeReportValue(item.size) === normalizeReportValue(size)
    );
    if (!matches.length) return "";
    const quantity = matches.reduce((total, item) => total + Number(item.current || 0), 0);
    return quantity.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const downloadRangeReport = async ({ blank = false } = {}) => {
    if (downloadingRangeReport) return;
    setDownloadingRangeReport(true);
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      drawStockRangeReportPdf(pdf, PRODUCT_RANGE_SECTIONS, {
        blank,
        getQuantity: getRangeReportQuantity,
      });
      pdf.save(blank ? "superiqfoam-stock-calculation-sheet.pdf" : "superiqfoam-current-stock.pdf");
      toast.success(blank ? "Stock calculation sheet downloaded" : "Current stock PDF downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download the stock PDF");
    } finally {
      setDownloadingRangeReport(false);
    }
  };

  const openDailyCountSheet = async () => {
    if (busy || updatingRightStock) return;
    setUpdatingRightStock(true);
    setLoadingDailyCount(true);
    try {
      const report = await api.get("/stock/daily-reconciliation");
      setDailyCountSheet({
        ...report,
        rows: report.rows.map((row) => ({
          ...row,
          made_today_input: row.made_today == null ? "" : String(row.made_today),
          physical_count: row.quantity == null ? "" : String(row.quantity),
        })),
      });
    } catch (error) {
      toast.error(`Could not load today's stock count: ${apiError(error)}`);
    } finally {
      setUpdatingRightStock(false);
      setLoadingDailyCount(false);
    }
  };

  const submitDailyCountSheet = async () => {
    if (!dailyCountSheet || updatingRightStock) return;
    const counts = dailyCountSheet.rows.map((row) => ({
      product: row.product,
      size: row.size,
      made_today: row.made_today_input === "" ? 0 : Number(row.made_today_input),
      quantity: row.physical_count === "" ? null : Number(row.physical_count),
    }));
    if (counts.some((line) =>
      !Number.isFinite(line.made_today) || line.made_today < 0
      || (line.quantity !== null && (!Number.isFinite(line.quantity) || line.quantity < 0))
    )) {
      toast.error("Enter valid non-negative quantities for today's production and any physical counts");
      return;
    }
    const confirmed = window.confirm(
      "Compile today's production quantities? Production will be recorded in the stock ledger. Physical counts are optional; if entered, differences will be recorded as audited adjustments.",
    );
    if (!confirmed) return;
    setUpdatingRightStock(true);
    try {
      const report = await api.post("/stock/daily-reconciliation", {
        report_date: dailyCountSheet.report_date,
        counts,
      });
      setDailyCountSheet({
        ...report,
        rows: report.rows.map((row) => ({
          ...row,
          made_today_input: row.made_today == null ? "" : String(row.made_today),
          physical_count: row.quantity == null ? "" : String(row.quantity),
        })),
      });
      toast.success("Today's production and stock update were compiled");
      load();
    } catch (error) {
      toast.error(`Could not reconcile today's stock: ${apiError(error)}`);
    }
    finally { setUpdatingRightStock(false); }
  };

  const updateSuppliedRightStock = async () => {
    if (busy || updatingRightStock) return;
    const confirmed = window.confirm(
      "Apply the supplied SuperIQFoam stock quantities by category and size? "
      + "This records audit-tracked stock movements and keeps all invoices and existing history. "
      + "Negative quantities (Ribbon Black backorders and White Drum) will be retained. "
      + "The per-size list will be used; its printed summary totals do not match the listed lines.",
    );
    if (!confirmed) return;
    setUpdatingRightStock(true);
    try {
      const result = await api.post("/stock/update-right-stock", {});
      toast.success(
        `Supplied stock applied: ${result.adjusted_items} adjustment(s), `
        + `${result.created_items} new size(s), ${result.duplicate_records_zeroed} duplicate row(s) set to zero. `
        + `Mattress quantity from listed sizes: ${result.net_mattress_stock}.`,
      );
      load();
    } catch (error) {
      toast.error(`Could not apply supplied stock: ${apiError(error)}`);
    } finally {
      setUpdatingRightStock(false);
    }
  };

  const getTotalsByCategory = () => {
    const totals = {};
    getCanonicalStock().forEach((s) => {
      const key = normalizeStockLabel(canonicalStockProduct(s.product));
      totals[key] = (totals[key] || 0) + Number(s.current || 0);
    });
    return totals;
  };

  const getTotalStock = () => getCanonicalStock().reduce((sum, s) => sum + Number(s.current || 0), 0);

  const getStockValueTotal = (zone) => {
    let total = 0;
    let unpriced = 0;
    getCanonicalStock().forEach((stock) => {
      const price = findSellingPrice(stock, zone);
      if (price?.price != null && price.confirmed) total += Number(stock.current || 0) * Number(price.price);
      else if (Number(stock.current || 0) !== 0) unpriced += 1;
    });
    return { total: fmtMoney(total), unpriced };
  };

  const saveStock = async () => {
    if (!addModal.product.trim() || !addModal.size.trim()) return toast.error("Product and size are required");
    const price = addModal.selling_price;
    if (price === "" || price == null || !Number.isFinite(Number(price)) || Number(price) < 0) {
      return toast.error("Selling price is required");
    }
    const payload = { ...addModal, product: addModal.product.trim(), size: addModal.size.trim(), selling_price: Number(price) };
    if (await run(() => api.post("/stock", payload), "Product and price saved")) setAddModal(null);
  };

  const findSellingPrice = (stock, zone) => {
    let priceCategory = stock.product;
    if (stock.product === "Simple") priceCategory = unifiedPriceList ? "Simple" : "Standard";
    if (stock.product === "Candy") priceCategory = "Ribbon Black";
    return prices.find((item) =>
      item.zone === (priceZonesEnabled ? zone : 1)
      && normalizeStockLabel(item.category) === normalizeStockLabel(priceCategory)
      && normalizeStockLabel(item.size) === normalizeStockLabel(stock.size)
      && item.active
    );
  };

  const getSellingPrice = (stock, zone) => {
    const price = findSellingPrice(stock, zone);
    return price?.price != null && price.confirmed ? fmtMoney(price.price) : "Not set";
  };
  const getStockValue = (stock, zone) => {
    const price = findSellingPrice(stock, zone);
    return price?.price != null && price.confirmed
      ? fmtMoney(Number(stock.current || 0) * Number(price.price))
      : "Not set";
  };

  const saveCost = async (stock) => {
    const draft = costDrafts[stock.id] ?? (stock.unit_cost ?? "");
    const unitCost = draft === "" ? null : Number(draft);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      return toast.error("Cost must be a finite non-negative amount");
    }
    if (await run(() => api.put(`/stock/${stock.id}`, {
      product: stock.product,
      size: stock.size,
      opening: stock.opening || 0,
      threshold: stock.threshold || 0,
      unit_cost: unitCost,
    }), "Cost saved")) {
      setCostDrafts((current) => ({ ...current, [stock.id]: unitCost ?? "" }));
    }
  };

  const deleteStock = async (stock) => {
    if (!window.confirm(`Permanently delete ${stock.product} ${stock.size} and all its stock movements? This cannot be undone.`)) return;
    if (busy) return;
    setBusy(true);
    try {
      await api.del(`/stock/${stock.id}`);
      setList((current) => current.filter((item) => item.id !== stock.id));
      setMovementRequest((current) => ({
        ...current,
        items: current.items.filter((movement) => movement.stock_id !== stock.id),
      }));
      toast.success("Stock product and its movements permanently deleted");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteStockCategory = async () => {
    const product = addModal?.category;
    if (!product || busy) return;
    const categoryStocks = (list || []).filter((stock) => stock.product === product);
    if (!categoryStocks.length) return toast.error("This category has no stock records to delete");
    const quantity = categoryStocks.reduce((total, stock) => total + Number(stock.current || 0), 0);
    if (!window.confirm(
      `Permanently delete "${product}" and all ${categoryStocks.length} stock record(s) across its sizes? `
      + `${quantity} current units and all related stock movements will be deleted. This cannot be undone.`,
    )) return;

    setBusy(true);
    let deletedCount = 0;
    try {
      for (const stock of categoryStocks) {
        await api.del(`/stock/${stock.id}`);
        deletedCount += 1;
      }
      toast.success(`Category "${product}" and its stock records permanently deleted`);
      setAddModal(null);
    } catch (error) {
      const progress = deletedCount
        ? `${deletedCount} of ${categoryStocks.length} records were deleted before the error. `
        : "";
      toast.error(`${progress}${apiError(error)}`);
    } finally {
      setBusy(false);
      load();
    }
  };

  const saveMove = async () => {
    if (!Number.isFinite(Number(moveModal.quantity)) || Number(moveModal.quantity) < 0) {
      return toast.error("Quantity cannot be negative");
    }
    if (await run(() => api.post(`/stock/${moveModal.stock_id}/movements`, moveModal), "Movement recorded")) setMoveModal(null);
  };

  const reverse = async (m) => {
    const reason = window.prompt(`Reverse ${TYPE_LABEL[m.type] || m.type} of ${m.quantity} (${m.product} ${m.size})? Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    await run(() => api.post(`/stock/movements/${m.id}/reverse`, { reason }), "Movement reversed");
  };

  const movementState = listViewState(movementRequest);
  const searchAction = (
    <Btn
      variant="outline"
      onClick={() => {
        setShowStockSearch((visible) => !visible);
        setStockSearch("");
      }}
      aria-expanded={showStockSearch}
      aria-controls="stock-search-input"
      data-testid="stock-search-toggle"
    >
      {showStockSearch ? <X size={16} /> : <Search size={16} />}
      {showStockSearch ? "Close search" : "Search stock"}
    </Btn>
  );
  const productIdsAction = <Btn variant="outline" onClick={() => setShowProductIds(true)} data-testid="product-identification-btn"><Boxes size={16} /> Product IDs</Btn>;
  const ledgerAction = <Btn variant="outline" onClick={() => { setShowHist(true); void loadMovements(); }} data-testid="stock-history-btn"><History size={16} /> Ledger</Btn>;
  const addProductAction = <Btn onClick={() => setAddModal({ product: "", category: "", size: "", opening: 0, threshold: 5, selling_price: "", zone: 1 })} data-testid="add-stock-btn"><Plus size={16} /> Add Product</Btn>;

  return (
    <div>
      <PageHeader title="Finished Stock" subtitle="Calculated from the stock movement ledger" />

      {isSuperIqFoam && (
        <div className="no-print mb-5 flex flex-wrap items-center gap-2 border-b border-slate-200 pb-4" data-testid="stock-update-actions">
          {user?.is_primary_owner && user?.is_owner && (
            <>
              <Btn
                type="button"
                onClick={openDailyCountSheet}
                disabled={updatingRightStock || busy || list === null}
                data-testid="update-daily-stock"
              >
                {loadingDailyCount ? "Loading..." : "COMPILE STOCK UPDATE"}
              </Btn>
              <Btn
                type="button"
                variant="outline"
                onClick={updateSuppliedRightStock}
                disabled={updatingRightStock || busy || list === null}
                data-testid="update-right-stock"
              >
                {updatingRightStock && !loadingDailyCount ? "Updating..." : "UPDATE STOCK"}
              </Btn>
            </>
          )}
          {productIdsAction}
          {ledgerAction}
          <Btn
            type="button"
            variant="outline"
            onClick={() => downloadRangeReport({ blank: true })}
            disabled={downloadingRangeReport}
            data-testid="download-stock-count-sheet"
          >
            <Download size={16} /> {downloadingRangeReport ? "Preparing..." : "Download Stock Calculating Sheet"}
          </Btn>
        </div>
      )}

      <div className="no-print -mt-3 mb-4 flex flex-wrap items-end gap-3">
        <div className="grid w-full max-w-2xl flex-1 gap-3 sm:grid-cols-2">
          {showStockSearch && (
            <Input
              id="stock-search-input"
              label="Search stock"
              type="search"
              placeholder="Product or size"
              value={stockSearch}
              onChange={(event) => setStockSearch(event.target.value)}
              data-testid="stock-search-input"
            />
          )}
          <Select label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)} data-testid="stock-category-filter">
            <option value="">All categories</option>
            {stockCategories.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {searchAction}
          {addProductAction}
          {isSuperIqFoam && (
            <>
              <Btn
                type="button"
                onClick={() => downloadRangeReport()}
                disabled={downloadingRangeReport}
                data-testid="download-product-range-report"
              >
                <Download size={16} /> {downloadingRangeReport ? "Preparing..." : "Download Current Stock PDF"}
              </Btn>
            </>
          )}
        </div>
      </div>

      <Modal
        open={!!dailyCountSheet}
        onClose={() => {
          if (!updatingRightStock) setDailyCountSheet(null);
        }}
        title={`Compile Stock Update — ${dailyCountSheet?.report_date || ""}`}
        wide
      >
        {dailyCountSheet && (
          <div className="flex min-h-0 flex-col">
            <div className="shrink-0 space-y-3 border-b border-border/70 px-4 py-4 sm:px-6">
              <p className="text-sm text-slate-600">
                Enter the number of pieces made today for each product and size. The stock ID and book balance are shown alongside today's invoices, dispatches, other movements, and receipts. Physical count is optional; when entered, it reconciles the ledger to the actual count.
              </p>
              {dailyCountSheet.already_submitted && (
                <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                  A production update has already been saved today. Saving again adjusts the production entry to the new total instead of double-counting it.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-md bg-slate-50 p-2">Invoice out: <strong>{dailyCountSheet.activity.invoice_out}</strong></div>
                <div className="rounded-md bg-slate-50 p-2">Dispatched: <strong>{dailyCountSheet.activity.dispatch_out}</strong></div>
                <div className="rounded-md bg-slate-50 p-2">Other out: <strong>{dailyCountSheet.activity.other_out}</strong></div>
                <div className="rounded-md bg-slate-50 p-2">Received in: <strong>{dailyCountSheet.activity.received_in}</strong></div>
                <div className="rounded-md bg-slate-50 p-2">Made today: <strong>{dailyCountSheet.activity.production_in}</strong></div>
              </div>
            </div>
            <div className="min-h-0 overflow-auto px-4 py-3 sm:px-6">
              <table className="w-full min-w-[1080px] border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                  <tr>
                    <th className="p-2">Category</th>
                    <th className="p-2">Size</th>
                    <th className="p-2">Product ID</th>
                    <th className="p-2 text-right">Book balance</th>
                    <th className="p-2">Pieces made today</th>
                    <th className="p-2 text-right">Invoice out</th>
                    <th className="p-2 text-right">Dispatched</th>
                    <th className="p-2 text-right">Other out</th>
                    <th className="p-2 text-right">Received in</th>
                    <th className="p-2">Physical count (optional)</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyCountSheet.rows.map((row) => (
                    <tr key={row.key} className="border-b border-slate-100">
                      <td className="p-2 font-medium">{row.product}</td>
                      <td className="p-2">{row.size}</td>
                      <td className="p-2 font-mono">{row.product_id || "—"}</td>
                      <td className="p-2 text-right font-mono">{row.book_quantity}</td>
                      <td className="p-2">
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          value={row.made_today_input}
                          onChange={(event) => setDailyCountSheet((current) => ({
                            ...current,
                            rows: current.rows.map((item) => item.key === row.key
                              ? { ...item, made_today_input: event.target.value }
                              : item),
                          }))}
                          aria-label={`Pieces made today for ${row.product} ${row.size}`}
                          data-testid={`made-today-${row.key}`}
                          className="min-w-24 px-2 py-1.5 text-right"
                        />
                      </td>
                      <td className="p-2 text-right font-mono">{row.invoice_out}</td>
                      <td className="p-2 text-right font-mono">{row.dispatch_out}</td>
                      <td className="p-2 text-right font-mono">{row.other_out}</td>
                      <td className="p-2 text-right font-mono">{row.received_in}</td>
                      <td className="p-2">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={row.physical_count}
                          onChange={(event) => setDailyCountSheet((current) => ({
                            ...current,
                            rows: current.rows.map((item) => item.key === row.key
                              ? { ...item, physical_count: event.target.value }
                              : item),
                          }))}
                          aria-label={`Optional physical count for ${row.product} ${row.size}`}
                          data-testid={`physical-count-${row.key}`}
                          className="min-w-24 px-2 py-1.5 text-right"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-border/70 px-4 py-3 sm:px-6">
              <Btn
                type="button"
                variant="outline"
                disabled={updatingRightStock}
                onClick={() => setDailyCountSheet(null)}
              >
                Cancel
              </Btn>
              <Btn
                type="button"
                disabled={updatingRightStock || dailyCountSheet.rows.length === 0}
                onClick={submitDailyCountSheet}
                data-testid="save-daily-stock-count"
              >
                {updatingRightStock ? "Saving..." : "Save & Update Stock"}
              </Btn>
            </div>
          </div>
        )}
      </Modal>

      <Card className="p-4 mb-6 bg-slate-50 border-slate-200">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-600">Stock Total</h2>
          <Btn
            type="button"
            variant="outline"
            className="px-3 py-1.5 text-xs"
            onClick={() => setShowStockTotals((visible) => !visible)}
            aria-expanded={showStockTotals}
            aria-controls="stock-total-summary"
            data-testid="stock-total-toggle"
          >
            {showStockTotals ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            {showStockTotals ? "Hide totals" : "Show totals"}
          </Btn>
        </div>
        <AnimatePresence initial={false}>
          {showStockTotals && (
            <motion.div
              id="stock-total-summary"
              key="stock-total-summary"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              {list === null ? (
                <p className="text-sm text-slate-400">Loading...</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                  {stockCategories.map((cat) => {
                    const total = getTotalsByCategory()[normalizeStockLabel(canonicalStockProduct(cat))] || 0;
                    return total > 0 ? (
                      <div key={cat} className="bg-white rounded-md p-3 border border-slate-200">
                        <p className="text-xs text-slate-500 font-semibold">{cat}</p>
                        <p className="text-lg font-mono font-bold text-slate-800">{total}</p>
                      </div>
                    ) : null;
                  })}
                  <div className="bg-white rounded-md p-3 border border-slate-300 border-2">
                    <p className="text-xs text-slate-600 font-semibold">Overall Total</p>
                    <p className="text-lg font-mono font-bold text-slate-900">{getTotalStock()}</p>
                  </div>
                  <div className="bg-white rounded-md p-3 border border-slate-200">
                    <p className="text-xs text-slate-500 font-semibold">Ribbon Total</p>
                    <p className="text-lg font-mono font-bold text-slate-800">{(getTotalsByCategory()[normalizeStockLabel(canonicalStockProduct("Ribbon Pink"))] || 0) + (getTotalsByCategory()[normalizeStockLabel(canonicalStockProduct("Ribbon Black"))] || 0)}</p>
                  </div>
                  <div className="bg-white rounded-md p-3 border border-slate-200">
                    <p className="text-xs text-slate-500 font-semibold">Strong Boy Total</p>
                    <p className="text-lg font-mono font-bold text-slate-800">{getTotalsByCategory()[normalizeStockLabel(canonicalStockProduct("Strong Boy"))] || 0}</p>
                  </div>
                  {canViewStockCosts && (() => {
                    const value = getStockValueTotal(valueZone);
                    return (
                      <div className="col-span-2 bg-white rounded-md p-3 border border-slate-300 border-2">
                        <label htmlFor="stock-value-zone" className="block text-xs text-slate-600 font-semibold">Total Stock Value</label>
                        {priceZonesEnabled && (
                          <select id="stock-value-zone" value={valueZone} onChange={(event) => setValueZone(Number(event.target.value))}
                            className="mt-1 mb-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs" data-testid="stock-value-zone">
                            <option value={1}>Zone 1</option>
                            <option value={2}>Zone 2</option>
                          </select>
                        )}
                        <p className="text-lg font-mono font-bold text-slate-900">{value.total}</p>
                        {value.unpriced > 0 && <p className="text-[11px] text-amber-600">{value.unpriced} item(s) without confirmed price not included</p>}
                      </div>
                    );
                  })()}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      <Card className="overflow-hidden">
        {list === null ? <p className="p-6 text-sm text-slate-400">Loading stock...</p> : filteredList.length === 0 ? <Empty icon={Boxes} title={stockSearch.trim() ? "No stock matches your search" : category ? "No stock items in this category" : "No stock records"} /> : (
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${canViewStockCosts ? "min-w-[1180px]" : "min-w-[900px]"}`}>
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="sticky left-0 z-20 bg-slate-50 px-3 py-3 font-semibold">Adjust</th><th className="px-4 py-3 font-semibold">Size</th><th className="px-4 font-semibold">Product</th><th className="px-4 font-semibold text-right">Other</th><th className="px-4 font-semibold text-right">Invoiced</th><th className="px-4 font-semibold text-right">Current Stock</th>{canViewStockCosts && <th className="px-4 font-semibold text-right">Cost (R)</th>}{unifiedPriceList || !priceZonesEnabled ? <><th className="px-4 font-semibold text-right">Selling Price</th>{canViewStockCosts && <th className="px-4 font-semibold text-right">Stock Value</th>}</> : <><th className="px-4 font-semibold text-right">Sell Zone 1</th>{canViewStockCosts && <th className="px-4 font-semibold text-right">Stock Value Zone 1</th>}<th className="px-4 font-semibold text-right">Sell Zone 2</th>{canViewStockCosts && <th className="px-4 font-semibold text-right">Stock Value Zone 2</th>}</>}<th className="sticky right-0 z-20 bg-slate-50 px-4 font-semibold text-right">Actions</th>
              </tr></thead>
              <tbody>{filteredList.map((s) => (
                <tr key={s.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`stock-row-${s.id}`}>
                  <td className="sticky left-0 z-10 bg-white px-3 whitespace-nowrap">
                    <button type="button" onClick={() => setMoveModal({ stock_id: s.id, label: `${s.product} ${s.size}`, current: s.current, type: "adjustment_in", quantity: 1, reason: "", reference: "", notes: "" })} className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1" aria-label={`Adjust ${s.product} ${s.size}`} data-testid={`move-stock-${s.id}`}><ArrowUpDown size={13} /> Adjust</button>
                  </td>
                  <td className="px-4 py-3 text-slate-500 font-mono">{s.size}</td>
                  <td className="px-4 font-semibold text-slate-800">{s.product}</td>
                  <td className="px-4 text-right font-mono text-slate-500">{s.adjustments || 0}</td>
                  <td className="px-4 text-right font-mono text-red-500">{s.invoiced ? `-${s.invoiced}` : 0}</td>
                  <td className="px-4 text-right"><span className={`font-mono font-bold ${s.current < s.threshold ? "text-red-600" : "text-slate-800"}`} data-testid={`stock-current-${s.id}`}>{s.current}</span>{s.current < s.threshold && <Badge cls="bg-red-50 text-red-700 border-red-200 ml-2">Low</Badge>}</td>
                  {canViewStockCosts && <td className="px-4">
                    <div className="flex items-center justify-end gap-2">
                      <Input aria-label={`Cost for ${s.product} ${s.size}`} type="number" min="0" step="0.01" value={costDrafts[s.id] ?? (s.unit_cost ?? "")} onChange={(e) => setCostDrafts((current) => ({ ...current, [s.id]: e.target.value }))} className="w-32 min-w-[8rem] max-w-none shrink-0 px-2 py-1.5 text-right tabular-nums" data-testid={`stock-cost-${s.id}`} />
                      <button type="button" onClick={() => saveCost(s)} disabled={busy} className="text-primary hover:underline text-xs font-semibold disabled:opacity-50" data-testid={`save-stock-cost-${s.id}`}>Save</button>
                    </div>
                  </td>}
                  {unifiedPriceList || !priceZonesEnabled
                    ? <><td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td>{canViewStockCosts && <td className="px-4 text-right font-mono" data-testid={`stock-value-${s.id}`}>{getStockValue(s, 1)}</td>}</>
                    : <><td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td>{canViewStockCosts && <td className="px-4 text-right font-mono" data-testid={`stock-value-zone-1-${s.id}`}>{getStockValue(s, 1)}</td>}<td className="px-4 text-right font-mono">{getSellingPrice(s, 2)}</td>{canViewStockCosts && <td className="px-4 text-right font-mono" data-testid={`stock-value-zone-2-${s.id}`}>{getStockValue(s, 2)}</td>}</>}
                  <td className="sticky right-0 z-10 bg-white px-4 text-right whitespace-nowrap">
                    {!user?.is_stock_only_worker && <button type="button" onClick={() => deleteStock(s)} disabled={busy} title="Permanently delete stock and movements" aria-label={`Permanently delete ${s.product} ${s.size}`} className="ml-2 rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50" data-testid={`delete-stock-${s.id}`}><Trash2 size={15} /></button>}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-400 mt-3">Purchases and production material use are posted from their source workflows. Correct discrepancies with a documented stock adjustment; manual movements can be reversed in the ledger.</p>

      <Modal open={!!addModal} onClose={() => setAddModal(null)} title="Add Stock Product">
        {addModal && <div className="space-y-4">
          <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Select
              label="Category (optional)"
              value={addModal.category || ""}
              onChange={(event) => {
                const selectedCategory = event.target.value;
                setAddModal({ ...addModal, category: selectedCategory, product: selectedCategory || addModal.product });
              }}
              data-testid="stock-category-input"
            >
              <option value="">No category — enter a product manually</option>
              {stockCategories.map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
            {addModal.category && !user?.is_stock_only_worker && (
              <Btn
                type="button"
                variant="danger"
                onClick={deleteStockCategory}
                disabled={busy || list === null}
                data-testid="delete-stock-category-btn"
              >
                <Trash2 size={15} /> Delete category
              </Btn>
            )}
          </div>
          <Input label="Product *" value={addModal.product} onChange={(e) => setAddModal({ ...addModal, product: e.target.value, category: "" })} data-testid="stock-product-input" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Size / measurement *" value={addModal.size} onChange={(e) => setAddModal({ ...addModal, size: e.target.value })} placeholder="910x100" data-testid="stock-size-input" />
            <Input label="Opening Balance" type="number" value={addModal.opening} onChange={(e) => setAddModal({ ...addModal, opening: Number(e.target.value) })} data-testid="stock-opening-input" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Minimum Stock" type="number" value={addModal.threshold} onChange={(e) => setAddModal({ ...addModal, threshold: Number(e.target.value) })} data-testid="stock-threshold-input" />
            <Input label="Selling Price (R) *" type="number" min="0" step="0.01" value={addModal.selling_price} onChange={(e) => setAddModal({ ...addModal, selling_price: e.target.value })} data-testid="stock-price-input" />
          </div>
          {priceZonesEnabled && <Select label="Price zone" value={addModal.zone} onChange={(e) => setAddModal({ ...addModal, zone: Number(e.target.value) })}><option value={1}>Zone 1</option><option value={2}>Zone 2</option></Select>}
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setAddModal(null)}>Cancel</Btn><Btn disabled={busy} onClick={saveStock} data-testid="save-stock-btn">Add</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!moveModal} onClose={() => setMoveModal(null)} title={`Stock Adjustment — ${moveModal?.label || ""}`}>
        {moveModal && <div className="space-y-4">
          <p className="text-xs text-slate-500">Current stock: <span className="font-mono font-bold">{moveModal.current}</span></p>
          <Select label="Movement Type" value={moveModal.type} onChange={(e) => setMoveModal({ ...moveModal, type: e.target.value })} data-testid="move-type-select">
            {MOVE_TYPES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </Select>
          <Input label="Quantity" type="number" min="0" step="any" value={moveModal.quantity} onChange={(e) => setMoveModal({ ...moveModal, quantity: Number(e.target.value) })} data-testid="move-qty-input" />
          <Input label="Reason (optional)" value={moveModal.reason} onChange={(e) => setMoveModal({ ...moveModal, reason: e.target.value })} data-testid="move-reason-input" />
          <Input label="Reference (optional)" value={moveModal.reference} onChange={(e) => setMoveModal({ ...moveModal, reference: e.target.value })} />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setMoveModal(null)}>Cancel</Btn><Btn disabled={busy} onClick={saveMove} data-testid="save-move-btn">Record</Btn></div>
        </div>}
      </Modal>

      <Modal open={showHist} onClose={() => setShowHist(false)} title="Stock Movement Ledger" wide>
        {movementState === "loading" && (
          <p className="py-8 text-center text-sm text-slate-400" role="status">Loading stock movements...</p>
        )}
        {movementState === "error" && (
          <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4" role="alert">
            <p className="text-sm text-red-700">Stock movements could not be loaded: {movementRequest.error}</p>
            <Btn variant="outline" onClick={() => { void loadMovements(); }} data-testid="stock-movements-retry">
              Retry
            </Btn>
          </div>
        )}
        {movementState === "empty" && (
          <p className="text-sm text-slate-400" data-testid="stock-movements-empty">No movements yet.</p>
        )}
        {(movementState === "items" || (movementState === "error" && movementRequest.items.length > 0)) && (
          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto">{movementRequest.items.map((m) => (
            <div key={m.id} className={`grid grid-cols-12 items-center gap-2 text-sm border border-border rounded-lg px-3 py-2 ${m.reversed ? "opacity-50" : ""}`} data-testid={`movement-row-${m.id}`}>
              <span className="col-span-3 font-semibold text-slate-700">{m.product} <span className="font-mono text-xs text-slate-400">{m.size}</span></span>
              <span className="col-span-2 text-xs"><Badge>{TYPE_LABEL[m.type] || m.type}</Badge></span>
              <span className="col-span-3 text-slate-400 text-xs truncate">{m.reason || m.reference}</span>
              <span className={`col-span-1 text-right font-mono font-semibold ${sign(m) > 0 ? "text-emerald-600" : "text-red-600"}`}>{sign(m) > 0 ? "+" : "-"}{m.quantity}</span>
              <span className="col-span-2 text-slate-400 text-xs">{fmtDateTime(m.created_at)}</span>
              <span className="col-span-1 text-right">{!user?.is_stock_only_worker && !m.reversed && ["adjustment_in", "adjustment_out", "return", "damage"].includes(m.type) && <button onClick={() => reverse(m)} title="Reverse" className="text-slate-400 hover:text-red-600" data-testid={`reverse-movement-${m.id}`}><Undo2 size={15} /></button>}</span>
            </div>))}</div>
        )}
      </Modal>
      {showProductIds && <Suspense fallback={<p className="text-sm text-slate-400">Loading product identification...</p>}>
        <ProductIdentificationManager
          stock={list || []}
          companyName={companyProfileName(user?.company_id)}
          onProductUpdated={load}
          onCreateProduct={() => {
            setShowProductIds(false);
            setAddModal({ product: "", category: "", size: "", opening: 0, threshold: 5, selling_price: "", zone: 1 });
          }}
          onClose={() => setShowProductIds(false)}
          onStockMovement={(product) => setMoveModal({
            stock_id: product.stock_id,
            label: `${product.product} ${product.dimensions}`,
            current: product.current_stock,
            type: "adjustment_in",
            quantity: 1,
            reason: "",
            reference: "",
            notes: "",
          })}
        />
      </Suspense>}
    </div>
  );
}
