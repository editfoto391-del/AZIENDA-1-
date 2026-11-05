import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { api, apiError } from "@/lib/api";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { companyProfileName, usesUnifiedPriceList } from "@/lib/company";
import { useAuth } from "@/context/AuthContext";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Boxes, Plus, ArrowUpDown, History, Undo2, Trash2, Search, X, ChevronDown, ChevronUp, Download, Layers3 } from "lucide-react";
import { listViewState, loadListRequest } from "@/lib/listRequest.mjs";

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
const isUppercaseCategory = (value) => {
  const name = String(value).trim();
  return name !== name.toLowerCase() && name === name.toUpperCase();
};
const WEEKLY_RANGE_SIZES = ["760x50", "760x75", "760x100", "760x120", "760x150", "910x50", "910x75", "910x100", "910x120", "910x150", "1070x50", "1070x75", "1070x100", "1070x120", "1070x150", "1370x50", "1370x75", "1370x100", "1370x120", "1370x150"];
const PRODUCT_RANGE_SECTIONS = [
  {
    title: "MIX-COLOR RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: WEEKLY_RANGE_SIZES.map((size, index) => ({ number: index + 1, size, type: "MIX-COLOR", group: "mix" })),
  },
  {
    title: "RIBBON RANGE",
    columns: ["#", "SIZE (mm)", "COLOR", "QTY / STOCK"],
    rows: ["760x100", "760x120", "760x150", "910x100", "910x120", "910x150"].flatMap((size, index) => [
      { number: index * 2 + 21, size, type: "RIBBON BLACK", group: "ribbon-black" },
      { number: index * 2 + 22, size, type: "RIBBON PINK", group: "ribbon-pink" },
    ]),
  },
  {
    title: "STRONG BOY RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: ["760x125", "910x125", "1070x125", "1370x125"].map((size, index) => ({
      number: index + 33, size, type: "STRONG BOY", group: "strong-boy",
    })),
  },
  {
    title: "UNCOVERED RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: ["910x100", "1070x100"].map((size, index) => ({
      number: index + 37, size, type: "UNCOVERED (BLUE 16 DENSITY)", group: "uncovered-blue",
    })),
  },
];
const REPORT_PRODUCT_NAMES = {
  mix: new Set(["simple", "standard", "simplemixcolor", "mixcolor"]),
  "ribbon-black": new Set(["ribbonblack", "ribbonbalck", "black"]),
  "ribbon-pink": new Set(["ribbonpink", "ribbon"]),
  "strong-boy": new Set(["strongboy"]),
  "uncovered-blue": new Set(["uncoveredblue16density"]),
};
const normalizeReportValue = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export default function Stock() {
  const { user } = useAuth();
  const isSuperIqFoam = user?.company_id === "superiqfoam";
  const reduceMotion = useReducedMotion();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
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

  const filteredList = (list || []).filter((item) =>
    (!category || (STOCK_CATEGORY[category] || [category]).includes(item.product))
    && (!stockSearch.trim() || `${item.product} ${item.size}`.toLowerCase().includes(stockSearch.trim().toLowerCase()))
  );
  const stockCategories = [...new Set((list || []).map((item) => item.product).filter(Boolean))]
    .filter((name) => !isUppercaseCategory(name));

  const run = async (fn, ok) => {
    if (busy) return; setBusy(true);
    try { await fn(); toast.success(ok); load(); return true; } catch (e) { toast.error(apiError(e)); return false; } finally { setBusy(false); }
  };

  // One row per product+size (latest record), so duplicate legacy rows are not counted twice.
  const getCanonicalStock = () => {
    const latest = new Map();
    (list || []).forEach((stock) => {
      const key = `${String(stock.product).toLowerCase()}|${String(stock.size).toLowerCase()}`;
      const existing = latest.get(key);
      if (!existing || String(stock.created_at || "") > String(existing.created_at || "")) latest.set(key, stock);
    });
    return [...latest.values()];
  };
  const canonicalStock = getCanonicalStock();
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
    const sourceSheet = document.getElementById("superiqfoam-product-range-report");
    const sheet = blank ? sourceSheet?.cloneNode(true) : sourceSheet;
    if (!sheet || downloadingRangeReport) return;
    setDownloadingRangeReport(true);
    if (blank) {
      sheet.removeAttribute("id");
      sheet.classList.add("download-only-sheet");
      sheet.setAttribute("aria-hidden", "true");
      sheet.querySelectorAll("[data-stock-quantity]").forEach((cell) => {
        cell.textContent = "";
      });
      document.body.appendChild(sheet);
    }
    try {
      await document.fonts?.ready;
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas-pro"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(sheet, {
        scale: 2,
        backgroundColor: "#ffffff",
        logging: false,
        width: sheet.scrollWidth,
        height: sheet.scrollHeight,
        windowWidth: Math.max(document.documentElement.clientWidth, window.innerWidth, sheet.scrollWidth),
      });
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const margin = 6;
      const scale = Math.min((297 - margin * 2) / canvas.width, (210 - margin * 2) / canvas.height);
      const width = canvas.width * scale;
      const height = canvas.height * scale;
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", (297 - width) / 2, (210 - height) / 2, width, height);
      pdf.save(blank ? "superiqfoam-stock-calculation-sheet.pdf" : "superiqfoam-current-stock.pdf");
      toast.success(blank ? "Stock calculation sheet downloaded" : "Current stock PDF downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not download the stock PDF");
    } finally {
      if (blank) sheet.remove();
      setDownloadingRangeReport(false);
    }
  };

  const getTotalsByCategory = () => {
    const totals = {};
    getCanonicalStock().forEach((s) => {
      totals[s.product] = (totals[s.product] || 0) + Number(s.current || 0);
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
      item.zone === (unifiedPriceList ? 1 : zone)
      && item.category === priceCategory
      && item.size === stock.size
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
  const productIdsAction = <Btn variant="outline" onClick={() => setShowProductIds(true)} data-testid="product-identification-btn"><Boxes size={16} /> Product IDs & Labels</Btn>;
  const ledgerAction = <Btn variant="outline" onClick={() => { setShowHist(true); void loadMovements(); }} data-testid="stock-history-btn"><History size={16} /> Ledger</Btn>;
  const addProductAction = <Btn onClick={() => setAddModal({ product: "", category: "", size: "", opening: 0, threshold: 5, selling_price: "", zone: 1 })} data-testid="add-stock-btn"><Plus size={16} /> Add Product</Btn>;

  return (
    <div>
      <PageHeader title="Finished Stock" subtitle="Calculated from the stock movement ledger" />

      {isSuperIqFoam && (
        <div className="download-only-sheet" aria-hidden="true">
            <div
              id="superiqfoam-product-range-report"
              className="stock-range-report mx-auto min-w-[1000px] max-w-[1100px] rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-sm"
              data-testid="product-range-report"
            >
              <header className="mb-3 rounded-t-md bg-[#10263e] px-4 py-3 text-white">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 border-r border-white/60 pr-4">
                    <Layers3 size={48} strokeWidth={2.5} className="shrink-0" aria-hidden="true" />
                    <div className="leading-none">
                      <h3 className="whitespace-nowrap text-[28px] font-black tracking-tight">SUPER IQ-FOAM</h3>
                      <p className="mt-2 whitespace-nowrap text-[11px] font-bold tracking-[0.16em]">QUALITY · COMFORT · TRUST</p>
                    </div>
                  </div>
                  <h3 className="text-right text-[32px] font-black leading-[1.05]">PRODUCT RANGE<br />REPORT</h3>
                </div>
              </header>
              <div className="mb-3 grid grid-cols-3 gap-4 bg-slate-100 px-3 py-2 text-[13px] font-bold">
                {["DATE:", "PREPARED BY:", "WAREHOUSE:"].map((label) => (
                  <div key={label} className="flex items-end gap-1">
                    <span className="whitespace-nowrap">{label}</span>
                    <span className="mb-0.5 min-w-0 flex-1 border-b border-slate-500" aria-hidden="true" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {PRODUCT_RANGE_SECTIONS.map((section) => (
                  <section
                    key={section.title}
                    className={`overflow-hidden rounded-md border border-slate-400 ${section.title.includes("STRONG") || section.title.includes("UNCOVERED") ? "" : "col-span-2"}`}
                  >
                    <h4 className="bg-[#10263e] px-3 py-2 text-[18px] font-extrabold text-white">{section.title}</h4>
                    <table className="w-full table-fixed border-collapse text-[13px] leading-[1.2]">
                      <colgroup>
                        {section.columns.map((column, index) => (
                          <col key={column} style={{ width: index === 0 ? "11%" : index === 1 ? "30%" : index === 2 ? "31%" : "28%" }} />
                        ))}
                      </colgroup>
                      <thead>
                        <tr className="bg-slate-200 font-extrabold">
                          {section.columns.map((column) => <th key={column} scope="col" className="border border-slate-400 px-2 py-2 text-center">{column}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((row) => (
                          <tr key={`${row.number}-${row.size}`} className="h-[24px]">
                            <td className="border border-slate-400 px-2 py-1 text-center font-semibold">{row.number}</td>
                            <td className="border border-slate-400 px-2 py-1 text-center font-bold">{row.size.replace("x", " X ")}</td>
                            <td className="border border-slate-400 px-2 py-1 text-center font-semibold">{row.type}</td>
                            <td className="border border-slate-400 px-2 py-1 text-center font-bold" data-stock-quantity>{getRangeReportQuantity(row.group, row.size)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                ))}
              </div>
              <footer className="mt-3 grid grid-cols-[1fr_0.7fr] gap-3">
                <section className="flex h-16 items-center gap-3 overflow-hidden rounded-md border border-slate-500">
                  <h4 className="flex h-full shrink-0 items-center bg-[#10263e] px-3 text-[13px] font-extrabold text-white">NOTES /<br />REMARKS:</h4>
                  <div className="flex-1" />
                </section>
                <section className="flex h-16 flex-col justify-between rounded-md bg-[#10263e] px-4 py-2 text-white">
                  <h4 className="text-[13px] font-extrabold">SIGNATURE:</h4>
                  <div className="border-b border-white" />
                </section>
              </footer>
            </div>
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
          {productIdsAction}
          {ledgerAction}
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
              <Btn
                type="button"
                variant="outline"
                onClick={() => downloadRangeReport({ blank: true })}
                disabled={downloadingRangeReport}
                data-testid="download-stock-count-sheet"
              >
                <Download size={16} /> {downloadingRangeReport ? "Preparing..." : "Download Stock Calculation Sheet"}
              </Btn>
            </>
          )}
        </div>
      </div>

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
                    const total = getTotalsByCategory()[cat] || 0;
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
                    <p className="text-lg font-mono font-bold text-slate-800">{(getTotalsByCategory()["Ribbon Pink"] || 0) + (getTotalsByCategory()["Ribbon Black"] || 0)}</p>
                  </div>
                  <div className="bg-white rounded-md p-3 border border-slate-200">
                    <p className="text-xs text-slate-500 font-semibold">Strong Boy Total</p>
                    <p className="text-lg font-mono font-bold text-slate-800">{getTotalsByCategory()["Strong Boy"] || 0}</p>
                  </div>
                  {!user?.is_worker && (() => {
                    const value = getStockValueTotal(valueZone);
                    return (
                      <div className="col-span-2 bg-white rounded-md p-3 border border-slate-300 border-2">
                        <label htmlFor="stock-value-zone" className="block text-xs text-slate-600 font-semibold">Total Stock Value</label>
                        {!unifiedPriceList && (
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
            <table className={`w-full text-sm ${user?.is_worker ? "min-w-[900px]" : "min-w-[1180px]"}`}>
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="sticky left-0 z-20 bg-slate-50 px-3 py-3 font-semibold">Adjust</th><th className="px-4 py-3 font-semibold">Size</th><th className="px-4 font-semibold">Product</th><th className="px-4 font-semibold text-right">Other</th><th className="px-4 font-semibold text-right">Invoiced</th><th className="px-4 font-semibold text-right">Current Stock</th>{!user?.is_worker && <th className="px-4 font-semibold text-right">Cost (R)</th>}{unifiedPriceList ? <><th className="px-4 font-semibold text-right">Selling Price</th>{!user?.is_worker && <th className="px-4 font-semibold text-right">Stock Value</th>}</> : <><th className="px-4 font-semibold text-right">Sell Zone 1</th>{!user?.is_worker && <th className="px-4 font-semibold text-right">Stock Value Zone 1</th>}<th className="px-4 font-semibold text-right">Sell Zone 2</th>{!user?.is_worker && <th className="px-4 font-semibold text-right">Stock Value Zone 2</th>}</>}<th className="sticky right-0 z-20 bg-slate-50 px-4 font-semibold text-right">Actions</th>
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
                  {!user?.is_worker && <td className="px-4">
                    <div className="flex items-center justify-end gap-2">
                      <Input aria-label={`Cost for ${s.product} ${s.size}`} type="number" min="0" step="0.01" value={costDrafts[s.id] ?? (s.unit_cost ?? "")} onChange={(e) => setCostDrafts((current) => ({ ...current, [s.id]: e.target.value }))} className="w-32 min-w-[8rem] max-w-none shrink-0 px-2 py-1.5 text-right tabular-nums" data-testid={`stock-cost-${s.id}`} />
                      <button type="button" onClick={() => saveCost(s)} disabled={busy} className="text-primary hover:underline text-xs font-semibold disabled:opacity-50" data-testid={`save-stock-cost-${s.id}`}>Save</button>
                    </div>
                  </td>}
                  {unifiedPriceList
                    ? <><td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td>{!user?.is_worker && <td className="px-4 text-right font-mono" data-testid={`stock-value-${s.id}`}>{getStockValue(s, 1)}</td>}</>
                    : <><td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td>{!user?.is_worker && <td className="px-4 text-right font-mono" data-testid={`stock-value-zone-1-${s.id}`}>{getStockValue(s, 1)}</td>}<td className="px-4 text-right font-mono">{getSellingPrice(s, 2)}</td>{!user?.is_worker && <td className="px-4 text-right font-mono" data-testid={`stock-value-zone-2-${s.id}`}>{getStockValue(s, 2)}</td>}</>}
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
          {!unifiedPriceList && <Select label="Price zone" value={addModal.zone} onChange={(e) => setAddModal({ ...addModal, zone: Number(e.target.value) })}><option value={1}>Zone 1</option><option value={2}>Zone 2</option></Select>}
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
