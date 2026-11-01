import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { companyProfileName, usesUnifiedPriceList } from "@/lib/company";
import { useAuth } from "@/context/AuthContext";
import { Card, Btn, Input, Select, Badge, Modal, PageHeader, Empty } from "@/components/common";
import { Boxes, Plus, ArrowUpDown, History, Undo2, Trash2 } from "lucide-react";
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
const CATEGORIES = ["Simple", "Ribbon Black", "Ribbon Pink", "Candy", "Uncovered", "Strong Boy"];
const STOCK_CATEGORY = {
  "Ribbon Black": ["Ribbon Black", "Ribbon Balck", "Black"],
  "Ribbon Balck": ["Ribbon Black", "Black"],
  "Ribbon Pink": ["Ribbon Pink", "Ribbon"],
};

export default function Stock() {
  const { user } = useAuth();
  const unifiedPriceList = usesUnifiedPriceList(user?.company_id);
  const [list, setList] = useState(null);
  const [prices, setPrices] = useState([]);
  const [costDrafts, setCostDrafts] = useState({});
  const [category, setCategory] = useState("");
  const [summaryCategory, setSummaryCategory] = useState("");
  const [summarySize, setSummarySize] = useState("");
  const [summaryZone, setSummaryZone] = useState("1");
  const [movementRequest, setMovementRequest] = useState({ items: [], loading: true, error: "" });
  const [addModal, setAddModal] = useState(null);
  const [moveModal, setMoveModal] = useState(null);
  const [showHist, setShowHist] = useState(false);
  const [showProductIds, setShowProductIds] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadMovements = () => loadListRequest({
    request: () => api.get("/stock/movements"),
    setState: setMovementRequest,
    errorMessage: apiError,
  });

  const load = () => {
    api.get("/stock").then(setList).catch((e) => { toast.error(apiError(e)); setList([]); });
    api.get("/prices").then(setPrices).catch((e) => toast.error(apiError(e)));
    void loadMovements();
  };
  useEffect(() => { load(); }, []);

  const filteredList = (list || []).filter((item) =>
    !category || (STOCK_CATEGORY[category] || [category]).includes(item.product)
  );
  const knownProducts = new Set(Object.values(STOCK_CATEGORY).flat().concat(CATEGORIES));
  const summaryCategories = [
    ...CATEGORIES.filter((item) =>
    (STOCK_CATEGORY[item] || [item]).some((product) => (list || []).some((stock) => stock.product === product))
    ),
    ...new Set((list || []).map((stock) => stock.product).filter((product) => !knownProducts.has(product))),
  ];
  const summarySizes = [...new Set((list || [])
    .filter((stock) => !summaryCategory || (STOCK_CATEGORY[summaryCategory] || [summaryCategory]).includes(stock.product))
    .map((stock) => stock.size)
  )].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const run = async (fn, ok) => {
    if (busy) return; setBusy(true);
    try { await fn(); toast.success(ok); load(); return true; } catch (e) { toast.error(apiError(e)); return false; } finally { setBusy(false); }
  };

  const saveStock = async () => {
    if (!addModal.product.trim() || !addModal.size.trim()) return toast.error("Product and size are required");
    if (await run(() => api.post("/stock", addModal), "Stock item added")) setAddModal(null);
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
  const summaryItems = (list || []).filter((stock) =>
    (!summaryCategory || (STOCK_CATEGORY[summaryCategory] || [summaryCategory]).includes(stock.product))
    && (!summarySize || stock.size === summarySize)
  );
  const summaryQuantity = summaryItems.reduce((total, stock) => total + Number(stock.current || 0), 0);
  const summaryValue = summaryItems.reduce((total, stock) => {
    const price = findSellingPrice(stock, Number(summaryZone));
    return total + (price?.price != null && price.confirmed ? Number(stock.current || 0) * Number(price.price) : 0);
  }, 0);
  const unpricedItems = summaryItems.filter((stock) => {
    const price = findSellingPrice(stock, Number(summaryZone));
    return price?.price == null || !price.confirmed;
  });
  const summaryRows = [...summaryItems]
    .sort((a, b) => a.product.localeCompare(b.product) || a.size.localeCompare(b.size, undefined, { numeric: true }))
    .map((stock) => {
      const price = findSellingPrice(stock, Number(summaryZone));
      const hasPrice = price?.price != null && price.confirmed;
      return {
        ...stock,
        unitPrice: hasPrice ? Number(price.price) : null,
        stockValue: hasPrice ? Number(stock.current || 0) * Number(price.price) : null,
      };
    });

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
      setMovements((current) => current.filter((movement) => movement.stock_id !== stock.id));
      toast.success("Stock product and its movements permanently deleted");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveMove = async () => {
    if (!(Number(moveModal.quantity) > 0)) return toast.error("Quantity must be positive");
    if (await run(() => api.post(`/stock/${moveModal.stock_id}/movements`, moveModal), "Movement recorded")) setMoveModal(null);
  };

  const reverse = async (m) => {
    const reason = window.prompt(`Reverse ${TYPE_LABEL[m.type] || m.type} of ${m.quantity} (${m.product} ${m.size})? Enter a reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    await run(() => api.post(`/stock/movements/${m.id}/reverse`, { reason }), "Movement reversed");
  };

  const movementState = listViewState(movementRequest);

  return (
    <div>
      <PageHeader title="Finished Stock" subtitle="Calculated from the stock movement ledger">
        <Btn variant="outline" onClick={() => setShowProductIds(true)} data-testid="product-identification-btn"><Boxes size={16} /> Product IDs & Labels</Btn>
        <Btn variant="outline" onClick={() => setShowHist(true)} data-testid="stock-history-btn"><History size={16} /> Ledger</Btn>
        <Btn onClick={() => setAddModal({ product: "", size: "", opening: 0, threshold: 5 })} data-testid="add-stock-btn"><Plus size={16} /> Add Product</Btn>
      </PageHeader>

      <div className="mb-4 max-w-xs">
        <Select label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)} data-testid="stock-category-filter">
          <option value="">All categories</option>
          {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
      </div>

      <Card className="mb-4 space-y-4 p-4" data-testid="stock-value-summary">
        <div>
          <h2 className="font-semibold text-slate-800">Stock quantity and value</h2>
          <p className="mt-1 text-xs text-slate-500">The value is estimated using confirmed selling prices for the selected zone.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label={unifiedPriceList ? "Price list" : "Zone"} value={summaryZone} onChange={(event) => setSummaryZone(event.target.value)} data-testid="stock-summary-zone">
            {unifiedPriceList
              ? <option value="1">Unified price</option>
              : <><option value="1">Zone 1</option><option value="2">Zone 2</option></>}
          </Select>
          <Select label="Category" value={summaryCategory} onChange={(event) => {
            setSummaryCategory(event.target.value);
            setSummarySize("");
          }} data-testid="stock-summary-category">
            <option value="">All categories</option>
            {summaryCategories.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
          <Select label="Measure" value={summarySize} onChange={(event) => setSummarySize(event.target.value)} data-testid="stock-summary-size">
            <option value="">All measures</option>
            {summarySizes.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase text-slate-500">Pieces in stock</p>
            <p className="mt-1 font-mono text-xl font-bold text-slate-800" data-testid="stock-summary-quantity">{summaryQuantity}</p>
          </div>
          <div className="rounded-lg border border-border bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase text-slate-500">Estimated value · {unifiedPriceList ? "Unified prices" : `Zone ${summaryZone}`}</p>
            <p className="mt-1 font-mono text-xl font-bold text-slate-800" data-testid="stock-summary-value">{fmtMoney(summaryValue)}</p>
            {unpricedItems.length > 0 && <p className="mt-1 text-xs text-amber-700">{unpricedItems.length} stock item(s) have no confirmed price in this zone; their value is excluded.</p>}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] text-sm" data-testid="stock-summary-breakdown">
            <thead>
              <tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500">
                <th className="px-3 py-2 font-semibold">Category</th>
                <th className="px-3 py-2 font-semibold">Measure</th>
                <th className="px-3 py-2 text-right font-semibold">Pieces in stock</th>
                <th className="px-3 py-2 text-right font-semibold">Price / piece</th>
                <th className="px-3 py-2 text-right font-semibold">Stock value (ZAR)</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.length === 0
                ? <tr><td colSpan={5} className="px-3 py-4 text-center text-sm text-slate-400">No stock for this category and measure.</td></tr>
                : summaryRows.map((stock) => (
                  <tr key={stock.id} className="border-b border-border/60 last:border-0" data-testid={`stock-summary-row-${stock.id}`}>
                    <td className="px-3 py-2 font-medium text-slate-700">{stock.product}</td>
                    <td className="px-3 py-2 font-mono text-slate-500">{stock.size}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold" data-testid={`stock-summary-item-quantity-${stock.id}`}>{stock.current || 0}</td>
                    <td className="px-3 py-2 text-right font-mono">{stock.unitPrice === null ? "Not set" : fmtMoney(stock.unitPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{stock.stockValue === null ? "Not set" : fmtMoney(stock.stockValue)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {list === null ? <p className="p-6 text-sm text-slate-400">Loading stock...</p> : filteredList.length === 0 ? <Empty icon={Boxes} title={category ? "No stock items in this category" : "No stock records"} /> : (
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${user?.is_worker ? "min-w-[760px]" : "min-w-[960px]"}`}>
              <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border">
                <th className="sticky left-0 z-20 bg-slate-50 px-3 py-3 font-semibold">Adjust</th><th className="px-4 py-3 font-semibold">Size</th><th className="px-4 font-semibold">Product</th><th className="px-4 font-semibold text-right">Other</th><th className="px-4 font-semibold text-right">Invoiced</th><th className="px-4 font-semibold text-right">Current Stock</th>{!user?.is_worker && <th className="px-4 font-semibold text-right">Cost (R)</th>}{unifiedPriceList ? <th className="px-4 font-semibold text-right">Selling Price</th> : <><th className="px-4 font-semibold text-right">Sell Zone 1</th><th className="px-4 font-semibold text-right">Sell Zone 2</th></>}<th className="sticky right-0 z-20 bg-slate-50 px-4 font-semibold text-right">Actions</th>
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
                      <Input aria-label={`Cost for ${s.product} ${s.size}`} type="number" min="0" step="0.01" value={costDrafts[s.id] ?? (s.unit_cost ?? "")} onChange={(e) => setCostDrafts((current) => ({ ...current, [s.id]: e.target.value }))} className="max-w-24 px-2 py-1.5 text-right" data-testid={`stock-cost-${s.id}`} />
                      <button type="button" onClick={() => saveCost(s)} disabled={busy} className="text-primary hover:underline text-xs font-semibold disabled:opacity-50" data-testid={`save-stock-cost-${s.id}`}>Save</button>
                    </div>
                  </td>}
                  {unifiedPriceList
                    ? <td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td>
                    : <><td className="px-4 text-right font-mono">{getSellingPrice(s, 1)}</td><td className="px-4 text-right font-mono">{getSellingPrice(s, 2)}</td></>}
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
          <Input label="Product *" value={addModal.product} onChange={(e) => setAddModal({ ...addModal, product: e.target.value })} data-testid="stock-product-input" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Size *" value={addModal.size} onChange={(e) => setAddModal({ ...addModal, size: e.target.value })} placeholder="910x100" data-testid="stock-size-input" />
            <Input label="Opening Balance" type="number" value={addModal.opening} onChange={(e) => setAddModal({ ...addModal, opening: Number(e.target.value) })} data-testid="stock-opening-input" />
          </div>
          <Input label="Minimum Stock" type="number" value={addModal.threshold} onChange={(e) => setAddModal({ ...addModal, threshold: Number(e.target.value) })} data-testid="stock-threshold-input" />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setAddModal(null)}>Cancel</Btn><Btn disabled={busy} onClick={saveStock} data-testid="save-stock-btn">Add</Btn></div>
        </div>}
      </Modal>

      <Modal open={!!moveModal} onClose={() => setMoveModal(null)} title={`Stock Adjustment — ${moveModal?.label || ""}`}>
        {moveModal && <div className="space-y-4">
          <p className="text-xs text-slate-500">Current stock: <span className="font-mono font-bold">{moveModal.current}</span></p>
          <Select label="Movement Type" value={moveModal.type} onChange={(e) => setMoveModal({ ...moveModal, type: e.target.value })} data-testid="move-type-select">
            {MOVE_TYPES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </Select>
          <Input label="Quantity" type="number" value={moveModal.quantity} onChange={(e) => setMoveModal({ ...moveModal, quantity: Number(e.target.value) })} data-testid="move-qty-input" />
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
            setAddModal({ product: "", size: "", opening: 0, threshold: 5 });
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
