import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { Building2, Pencil, Plus, Search, ShoppingCart, Trash2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtMoney, today } from "@/lib/format";
import { Btn, Card, Empty, Input, Modal, PageHeader, Select, Textarea } from "@/components/common";

const blankBuying = () => ({
  product: "",
  product_mode: "stock",
  stock_category: "",
  stock_id: "",
  size: "",
  item_type: "",
  source: "",
  supplier_id: "",
  quantity: "1",
  unit_price: "",
  date: today(),
  notes: "",
});

export default function Buyings() {
  const [buyings, setBuyings] = useState(null);
  const [stock, setStock] = useState(null);
  const [suppliers, setSuppliers] = useState(null);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get("/buyings")
      .then(setBuyings)
      .catch((error) => {
        toast.error(apiError(error));
        setBuyings([]);
      });
    api.get("/suppliers")
      .then(setSuppliers)
      .catch((error) => {
        toast.error(apiError(error));
        setSuppliers([]);
      });
    api.get("/stock")
      .then(setStock)
      .catch((error) => {
        toast.error(apiError(error));
        setStock([]);
      });
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => (buyings || []).filter((buying) =>
    `${buying.product} ${buying.size || ""} ${buying.source} ${buying.item_type || ""} ${buying.notes || ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  ), [buyings, query]);
  const total = filtered.reduce((sum, buying) => sum + Number(buying.amount || 0), 0);
  const formTotal = (Number(modal?.quantity) || 0) * (Number(modal?.unit_price) || 0);
  const quantityUnit = (product) => product?.trim().toLowerCase() === "chemical" ? "L" : "";
  const stockCategories = [...new Set((stock || []).map((item) => item.product).filter(Boolean))].sort();
  const selectedStockProduct = stock?.find((item) => item.id === modal?.stock_id);
  const selectedStockCategory = modal?.stock_category || selectedStockProduct?.product || "";
  const stockSizes = (stock || [])
    .filter((item) => item.product === selectedStockCategory)
    .map((item) => item.size)
    .filter((size, index, sizes) => size && sizes.indexOf(size) === index)
    .sort();
  const formatBuyingProduct = (buying) => [buying.product, buying.size].filter(Boolean).join(" ");

  const save = async () => {
    if (modal.product_mode === "stock" && (!modal.stock_id || !modal.size)) return toast.error("Select a stock product and size");
    if (modal.product_mode === "manual" && !modal.product.trim()) return toast.error("Product is required");
    if (!modal.item_type) return toast.error("Choose whether this is a selling product or raw material");
    if (!modal.supplier_id && !modal.source.trim()) return toast.error("Select a supplier or enter a source");
    if (!(Number(modal.quantity) > 0)) return toast.error("Quantity must be greater than 0");
    if (!(Number(modal.unit_price) > 0)) return toast.error("Unit price must be greater than 0");
    if (saving) return;
    setSaving(true);
    try {
      const selectedSupplier = suppliers?.find((supplier) => supplier.id === modal.supplier_id);
      const payload = {
        ...modal,
        product: modal.product_mode === "stock" ? selectedStockProduct?.product || modal.product : modal.product,
        stock_id: modal.product_mode === "stock" ? modal.stock_id : "",
        size: modal.product_mode === "stock" ? modal.size : "",
        source: selectedSupplier?.name || modal.source,
        quantity: Number(modal.quantity),
        unit_price: Number(modal.unit_price),
      };
      if (modal.id) await api.put(`/buyings/${modal.id}`, payload);
      else await api.post("/buyings", payload);
      toast.success("Buying saved");
      setModal(null);
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const voidBuying = async (buying) => {
    const reason = window.prompt(`Void purchase "${formatBuyingProduct(buying)}" (${fmtMoney(buying.amount)})? Reason:`);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("A reason is required");
    try {
      await api.post(`/buyings/${buying.id}/void`, { reason });
      toast.success("Buying voided");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div>
      <PageHeader title="Buyings" subtitle="Record items purchased and their costs">
        <Link to="/suppliers" className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-secondary" data-testid="buyings-suppliers-link"><Building2 size={16} /> Manage Suppliers</Link>
        <Btn onClick={() => setModal(blankBuying())} data-testid="add-buying-btn"><Plus size={16} /> Add Buying</Btn>
      </PageHeader>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search product, source or notes..."
            aria-label="Search buyings"
            data-testid="buyings-search"
            className="w-full rounded-lg border border-input pl-9 pr-3 py-2.5 text-sm outline-none focus:border-primary"
          />
        </div>
        <p className="text-sm text-slate-500">Filtered total: <span className="font-mono font-bold text-slate-800">{fmtMoney(total)}</span></p>
      </Card>

      <Card className="overflow-hidden">
        {buyings === null ? <p className="p-6 text-sm text-slate-400" role="status">Loading purchases...</p> : filtered.length === 0 ? (
          <Empty icon={ShoppingCart} title="No purchases recorded" hint="Add your first buying to keep track of purchased items." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Product</th>
                  <th className="px-4 py-3 font-semibold">Bought from</th>
                  <th className="px-4 py-3 text-right font-semibold">Quantity</th>
                  <th className="px-4 py-3 text-right font-semibold">Unit price</th>
                  <th className="px-4 py-3 text-right font-semibold">Total</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((buying) => (
                  <tr key={buying.id} className="border-b border-border/60 hover:bg-slate-50" data-testid={`buying-row-${buying.id}`}>
                    <td className="px-4 py-3 text-slate-500">{fmtDate(buying.date)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {formatBuyingProduct(buying)}
                      {buying.notes && <p className="mt-0.5 max-w-56 truncate text-xs font-normal text-slate-400">{buying.notes}</p>}
                      <p className="mt-0.5 text-xs font-normal text-slate-400">{buying.item_type === "selling_product" ? "Selling Product" : "Raw Material"}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{suppliers?.find((supplier) => supplier.id === buying.supplier_id)?.name || buying.source}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {buying.quantity}{(buying.quantity_unit || quantityUnit(buying.product)) && ` ${buying.quantity_unit || quantityUnit(buying.product)}`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{fmtMoney(buying.unit_price)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">{fmtMoney(buying.amount)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setModal({ ...buying, product_mode: buying.stock_id ? "stock" : "manual", stock_category: buying.product, supplier_id: buying.supplier_id || "", quantity: String(buying.quantity), unit_price: String(buying.unit_price), item_type: buying.item_type || "raw_material" })}
                        aria-label={`Edit ${formatBuyingProduct(buying)}`}
                        data-testid={`edit-buying-${buying.id}`}
                        className="rounded p-1.5 text-slate-400 hover:text-primary"
                      ><Pencil size={15} /></button>
                      <button
                        type="button"
                        onClick={() => voidBuying(buying)}
                        aria-label={`Void ${buying.product}`}
                        data-testid={`void-buying-${buying.id}`}
                        className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      ><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!modal} onClose={() => !saving && setModal(null)} title={modal?.id ? "Edit Buying" : "Add Buying"}>
        {modal && (
          <div className="space-y-4">
            <Select
              label="Product / item"
              value={modal.product_mode}
              onChange={(event) => setModal({ ...modal, product_mode: event.target.value, stock_category: "", stock_id: "", size: "", product: "" })}
              data-testid="buying-product-mode"
            >
              <option value="stock">Select from Stock</option>
              <option value="manual">Enter manually</option>
            </Select>
            {modal.product_mode === "stock" ? (
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Category / product"
                  value={selectedStockCategory}
                  onChange={(event) => setModal({ ...modal, stock_category: event.target.value, stock_id: "", size: "", product: event.target.value })}
                  data-testid="buying-stock-category"
                >
                  <option value="">Select product...</option>
                  {stockCategories.map((product) => <option key={product} value={product}>{product}</option>)}
                </Select>
                <Select
                  label="Size"
                  value={modal.size || ""}
                  disabled={!selectedStockCategory}
                  onChange={(event) => {
                    const item = (stock || []).find((candidate) => candidate.product === selectedStockCategory && candidate.size === event.target.value);
                    setModal({ ...modal, stock_id: item?.id || "", stock_category: selectedStockCategory, product: item?.product || selectedStockCategory, size: item?.size || "" });
                  }}
                  data-testid="buying-stock-size"
                >
                  <option value="">Select size...</option>
                  {stockSizes.map((size) => {
                    const item = (stock || []).find((candidate) => candidate.product === selectedStockCategory && candidate.size === size);
                    return <option key={size} value={size}>{size} · Current stock: {item?.current ?? 0}</option>;
                  })}
                </Select>
              </div>
            ) : (
              <Input
                label="Product / item"
                value={modal.product}
                onChange={(event) => setModal({ ...modal, product: event.target.value })}
                placeholder="Type the item name"
                data-testid="buying-product"
                required
              />
            )}
            <Select
              label="This is..."
              value={modal.item_type || ""}
              onChange={(event) => setModal({ ...modal, item_type: event.target.value })}
              data-testid="buying-item-type"
              required
            >
              <option value="">Select type...</option>
              <option value="selling_product">Selling Product</option>
              <option value="raw_material">Raw Material</option>
            </Select>
            <Select
              label="Supplier"
              value={modal.supplier_id || ""}
              onChange={(event) => {
                const supplierId = event.target.value;
                const supplier = suppliers?.find((item) => item.id === supplierId);
                setModal({ ...modal, supplier_id: supplierId, source: supplier?.name || "" });
              }}
              data-testid="buying-supplier"
            >
              <option value="">Other source / not listed</option>
              {(suppliers || []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}{supplier.active === false ? " (Inactive)" : ""}
                </option>
              ))}
            </Select>
            {!modal.supplier_id && <Input
              label="Bought from *"
              value={modal.source}
              onChange={(event) => setModal({ ...modal, source: event.target.value })}
              placeholder="Enter source"
              data-testid="buying-source"
              required
            />}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={quantityUnit(modal.product) ? "Quantity (L)" : "Quantity"}
                type="number"
                min="0.01"
                step="0.01"
                value={modal.quantity}
                onChange={(event) => setModal({ ...modal, quantity: event.target.value })}
                data-testid="buying-quantity"
                required
              />
              <Input
                label="Unit price (R)"
                type="number"
                min="0.01"
                step="0.01"
                value={modal.unit_price}
                onChange={(event) => setModal({ ...modal, unit_price: event.target.value })}
                data-testid="buying-unit-price"
                required
              />
            </div>
            <p className="text-right text-sm text-slate-500">Total: <span className="font-mono font-bold text-slate-800">{fmtMoney(formTotal)}</span></p>
            <Input label="Purchase date" type="date" value={modal.date} onChange={(event) => setModal({ ...modal, date: event.target.value })} />
            <Textarea label="Notes (optional)" rows={2} value={modal.notes || ""} onChange={(event) => setModal({ ...modal, notes: event.target.value })} />
            <div className="flex justify-end gap-2">
              <Btn variant="outline" onClick={() => setModal(null)} disabled={saving}>Cancel</Btn>
              <Btn onClick={save} disabled={saving} data-testid="save-buying-btn">{saving ? "Saving..." : "Save Buying"}</Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
