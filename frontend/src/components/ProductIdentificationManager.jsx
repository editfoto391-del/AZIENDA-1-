import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { Btn, Card, Input, Modal } from "@/components/common";
import BarcodeScanner from "@/components/BarcodeScanner";
import { ChevronLeft, ChevronRight, Download, Plus, Printer, Save, ScanLine, Tag } from "lucide-react";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

const codeSvg = (bwipjs, bcid, text, scale = 3) => bwipjs.toSVG({
  bcid, text, scale, padding: 8, backgroundcolor: "FFFFFF",
  ...(bcid === "ean13" ? { includetext: true, textsize: 10, height: 12 } : {}),
});

const svgDataUrl = (svg) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
const stockIdOf = (item) => item?.stock_id ?? item?.id;

function ProductCodePreviews({ identity }) {
  const [images, setImages] = useState(null);
  useEffect(() => {
    let active = true;
    setImages(null);
    import("bwip-js").then(({ default: bwipjs }) => {
      if (!active) return;
      setImages({
        qr: svgDataUrl(codeSvg(bwipjs, "qrcode", identity.qr_payload, 4)),
        dataMatrix: identity.data_matrix_payload
          ? svgDataUrl(codeSvg(bwipjs, "datamatrix", identity.data_matrix_payload, 4))
          : null,
        ean13: identity.ean13 ? svgDataUrl(codeSvg(bwipjs, "ean13", identity.ean13, 3)) : null,
      });
    }).catch((error) => toast.error(error?.message || "Barcode previews could not be generated"));
    return () => { active = false; };
  }, [identity]);
  return (
    <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2 text-center text-[10px] text-slate-500">
      <figure><figcaption className="mb-1 font-semibold">QR</figcaption>{images ? <img className="mx-auto h-20 w-20" src={images.qr} alt="Product QR code" /> : <span>Generating…</span>}</figure>
      <figure><figcaption className="mb-1 font-semibold">Data Matrix</figcaption>{images?.dataMatrix ? <img className="mx-auto h-20 w-20" src={images.dataMatrix} alt="Product Data Matrix code" /> : <span>{identity.data_matrix_payload || "Not registered"}</span>}</figure>
      <figure><figcaption className="mb-1 font-semibold">EAN-13</figcaption>{images?.ean13 ? <img className="mx-auto h-20 w-full object-contain" src={images.ean13} alt="GS1 EAN-13 barcode" /> : <span>{identity.ean13 || "Not registered"}</span>}</figure>
    </div>
  );
}

const labelHtml = (bwipjs, product) => {
  const qr = codeSvg(bwipjs, "qrcode", product.qr_payload, 4);
  const dataMatrix = product.data_matrix_payload ? codeSvg(bwipjs, "datamatrix", product.data_matrix_payload, 4) : "";
  const ean = product.ean13 ? codeSvg(bwipjs, "ean13", product.ean13, 3) : "";
  return `<section class="label">
    <header>${escapeHtml(product.company_name)}</header>
    <strong>${escapeHtml(product.product)}</strong>
    <div>${escapeHtml(product.dimensions)}${product.unit ? ` ${escapeHtml(product.unit)}` : ""}${product.density ? ` · Density ${escapeHtml(product.density)}` : ""}</div>
    <small>SKU ${escapeHtml(product.sku)} · ${escapeHtml(product.product_id)}</small>
    <div class="codes">
      <figure>${qr}<figcaption>QR</figcaption></figure>
      ${dataMatrix ? `<figure>${dataMatrix}<figcaption>Data Matrix</figcaption></figure>` : ""}
      <figure class="ean">${ean || "<span>GS1 EAN-13 not registered</span>"}${ean ? "<figcaption>EAN-13 · GS1 allocated</figcaption>" : ""}</figure>
    </div>
  </section>`;
};

const svgImage = (svg) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("Could not render a barcode for the label"));
  image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
});

async function productLabelCanvas(bwipjs, product, width, height) {
  const scale = 300 / 25.4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the label canvas");
  context.scale(scale, scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.textBaseline = "alphabetic";
  context.font = "bold 4px Arial";
  context.fillText(product.company_name, 3, 5, width - 6);
  context.font = "bold 5px Arial";
  context.fillText(product.product, 3, 11, width - 6);
  context.font = "3px Arial";
  context.fillText(`${product.dimensions}${product.unit ? ` ${product.unit}` : ""}${product.density ? ` · Density ${product.density}` : ""}`, 3, 16, width - 6);
  context.font = "2.6px monospace";
  context.fillText(`SKU ${product.sku}`, 3, 20, width - 6);
  context.fillText(product.product_id, 3, 23, width - 6);

  const qr = await svgImage(codeSvg(bwipjs, "qrcode", product.qr_payload, 4));
  const qrSize = Math.min(21, (width - 6 - (width * 0.36) - 4) / 2);
  context.drawImage(qr, 3, 26, qrSize, qrSize);
  if (product.data_matrix_payload) {
    const matrix = await svgImage(codeSvg(bwipjs, "datamatrix", product.data_matrix_payload, 4));
    context.drawImage(matrix, 3 + qrSize + 4, 26, qrSize, qrSize);
  }
  context.font = "2.5px Arial";
  context.fillText("QR", 3 + qrSize / 2 - 2, 26 + qrSize + 3);
  if (product.data_matrix_payload) context.fillText("Data Matrix", 3 + qrSize + 4, 26 + qrSize + 3);
  if (product.ean13) {
    const ean = await svgImage(codeSvg(bwipjs, "ean13", product.ean13, 3));
    const eanWidth = width * 0.36;
    context.drawImage(ean, width - eanWidth - 3, 27, eanWidth, Math.min(height - 30, 22));
  } else {
    context.fillText("No EAN-13", width * 0.68, 35, width * 0.28);
  }
  return canvas;
}

export default function ProductIdentificationManager({ stock, companyName, onStockMovement, onProductUpdated, onCreateProduct, onClose }) {
  const [selectedStock, setSelectedStock] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [draft, setDraft] = useState(null);
  const [stockDraft, setStockDraft] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [densityFilter, setDensityFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [catalog, setCatalog] = useState({ items: [], total: 0, page: 1, pages: 0 });
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [page, setPage] = useState(1);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [labelSize, setLabelSize] = useState({ width: 100, height: 60 });
  const [scanResult, setScanResult] = useState(null);

  const refreshStats = () => api.getUncached("/product-identification-stats")
    .then(setStats).catch((error) => toast.error(apiError(error)));
  useEffect(() => {
    refreshStats();
  }, []);
  useEffect(() => {
    setSelectedIds([]);
    setSelectedStock(null);
    setIdentity(null);
    setDraft(null);
    setStockDraft(null);
    setScanResult(null);
  }, [companyName]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const params = {
        q: search.trim(),
        category: categoryFilter.trim() || undefined,
        density: densityFilter.trim() || undefined,
        active: activeFilter === "" ? undefined : activeFilter === "true",
        page,
        page_size: 50,
      };
      setCatalogLoading(true);
      setCatalogError("");
      api.getUncached("/products", params).then((result) => {
        if (active) {
          setCatalog(result);
          setCatalogLoading(false);
        }
      }).catch((error) => {
        if (active) {
          setCatalogError(apiError(error));
          setCatalogLoading(false);
        }
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search, categoryFilter, densityFilter, activeFilter, page, catalogRevision]);

  const manageProduct = async (item) => {
    const stockId = stockIdOf(item);
    if (!stockId) {
      toast.error("This product has no stock identifier. Reload the product list and try again.");
      return;
    }
    setBusy(true);
    setIdentityLoading(true);
    setIdentity(null);
    setDraft(null);
    setStockDraft(null);
    try {
      const current = await api.getUncached(`/stock/${stockId}/identification`);
      setSelectedStock({ ...item, id: stockId, stock_id: stockId });
      setIdentity(current);
      setStockDraft({
        product: current.product || "",
        dimensions: current.dimensions || "",
      });
      setDraft({
        description: current.description || "",
        sku: current.sku || "",
        category: current.category || "",
        density: current.density || "",
        product_type: current.product_type || "",
        length: current.length ?? "",
        width: current.width ?? "",
        thickness: current.thickness ?? "",
        unit: current.unit || "",
        ean13: current.ean13 || "",
        data_matrix_payload: current.data_matrix_payload || "",
        gs1_allocated: !!current.gs1_allocated,
        active: current.active !== false,
      });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setIdentityLoading(false);
      setBusy(false);
    }
  };

  const saveIdentity = async () => {
    if (!selectedStock || !draft || busy) return;
    setBusy(true);
    try {
      const stockId = stockIdOf(selectedStock);
      const updated = await api.put(`/stock/${stockId}/identification`, {
        ...draft,
        sku: draft.sku.trim() || null,
        category: draft.category.trim() || null,
        density: draft.density.trim() || null,
        length: draft.length === "" ? null : Number(draft.length),
        width: draft.width === "" ? null : Number(draft.width),
        thickness: draft.thickness === "" ? null : Number(draft.thickness),
        unit: draft.unit.trim() || null,
        ean13: draft.ean13.trim() || null,
        data_matrix_payload: draft.data_matrix_payload.trim() || null,
      });
      setIdentity(updated);
      setSelectedStock((current) => ({ ...current, ...updated, id: stockId }));
      setCatalog((current) => ({
        ...current,
        items: current.items.map((item) => stockIdOf(item) === stockId
          ? { ...item, ...updated, id: stockId }
          : item),
      }));
      setDraft({
        description: updated.description || "",
        sku: updated.sku || "",
        category: updated.category || "",
        density: updated.density || "",
        product_type: updated.product_type || "",
        length: updated.length ?? "",
        width: updated.width ?? "",
        thickness: updated.thickness ?? "",
        unit: updated.unit || "",
        ean13: updated.ean13 || "",
        data_matrix_payload: updated.data_matrix_payload || "",
        gs1_allocated: !!updated.gs1_allocated,
        active: updated.active !== false,
      });
      refreshStats();
      setCatalogRevision((revision) => revision + 1);
      toast.success("Product identification saved");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveStockDetails = async () => {
    if (!selectedStock || !stockDraft || busy) return;
    setBusy(true);
    try {
      const updated = await api.put(
        `/stock/${stockIdOf(selectedStock)}/product-details`,
        stockDraft,
      );
      setIdentity(updated);
      setDraft((current) => current && current.category === selectedStock.product
        ? { ...current, category: updated.category }
        : current);
      setSelectedStock((current) => ({ ...current, product: updated.product, size: updated.dimensions }));
      setCatalog((current) => ({
        ...current,
        items: current.items.map((item) => stockIdOf(item) === updated.stock_id
          ? { ...item, ...updated, id: updated.stock_id }
          : item),
      }));
      onProductUpdated?.();
      refreshStats();
      setCatalogRevision((revision) => revision + 1);
      toast.success("Product name and dimensions saved");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBusy(false);
    }
  };

  const scanProduct = async (code) => {
    try {
      const product = await api.post("/products/scan", {
        code,
        scan_id: globalThis.crypto?.randomUUID?.(),
      });
      setScanResult(product);
      const match = stock.find((item) => stockIdOf(item) === product.stock_id);
      if (match) await manageProduct(match);
      refreshStats();
      toast.success(`${product.product} · ${product.dimensions}${product.unit ? ` ${product.unit}` : ""}`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const selectedProducts = stock.filter((item) => selectedIds.includes(stockIdOf(item)));

  const downloadLabels = async () => {
    if (!selectedProducts.length || busy) return;
    const width = Number(labelSize.width);
    const height = Number(labelSize.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 75 || height < 48 || width > 300 || height > 300) {
      toast.error("Label dimensions must be between 75×48 mm and 300×300 mm");
      return;
    }
    setBusy(true);
    try {
      const [{ jsPDF }, { default: bwipjs }] = await Promise.all([
        import("jspdf"),
        import("bwip-js"),
      ]);
      const products = await Promise.all(selectedProducts.map(async (item) => {
        const detail = await api.getUncached(`/stock/${item.id}/identification`);
        return { ...detail, currentStock: item.current ?? 0 };
      }));
      const pdf = new jsPDF({ unit: "mm", format: [width, height] });
      for (const [index, product] of products.entries()) {
        if (index) pdf.addPage([width, height]);
        const canvas = await productLabelCanvas(bwipjs, product, width, height);
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, width, height);
      }
      pdf.save("iqfoam-product-labels.pdf");
      toast.success(`${products.length} label${products.length === 1 ? "" : "s"} downloaded`);
    } catch (error) {
      toast.error(error?.message || apiError(error));
    } finally {
      setBusy(false);
    }
  };

  const printLabels = async () => {
    if (!selectedProducts.length || busy) return;
    const width = Number(labelSize.width);
    const height = Number(labelSize.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 75 || height < 48 || width > 300 || height > 300) {
      toast.error("Label dimensions must be between 75×48 mm and 300×300 mm");
      return;
    }
    const popup = window.open("", "_blank");
    if (!popup) {
      toast.error("Allow pop-ups to print labels");
      return;
    }
    setBusy(true);
    try {
      const { default: bwipjs } = await import("bwip-js");
      const codeSize = Math.min(21, (width - 6 - (width * 0.36) - 4) / 2);
      const eanWidth = width * 0.36;
      const products = await Promise.all(selectedProducts.map((item) =>
        api.getUncached(`/stock/${item.id}/identification`)
      ));
      popup.document.write(`<!doctype html><html><head><title>IQFOAM Product Labels</title><style>
        @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}
        body{margin:0;font:8pt Arial,sans-serif;color:#111}
        .label{width:${width}mm;height:${height}mm;padding:3mm;page-break-after:always;overflow:hidden}.label:last-child{page-break-after:auto}
        header{font-size:8pt;font-weight:bold}.label>strong{display:block;font-size:12pt;margin-top:1mm}
        .label>div,.label>small{font-size:7pt}.codes{display:flex;align-items:flex-start;gap:3mm;margin-top:2mm}
        figure{margin:0;text-align:center;font-size:6pt}.codes figure:first-child svg,.codes figure:nth-child(2) svg{width:${codeSize}mm;height:${codeSize}mm}
        .ean{width:${eanWidth}mm}.ean svg{width:${eanWidth}mm;height:22mm}.ean span{display:inline-block;width:${eanWidth}mm;margin-top:8mm;font-size:7pt}
        figcaption{margin-top:1mm}@media screen{body{background:#e2e8f0}.label{background:#fff;margin:8mm auto;box-shadow:0 2px 8px #0002}}
      </style></head><body>${products.map((product) => labelHtml(bwipjs, product)).join("")}</body>
      <script>window.addEventListener("load",()=>{window.focus();window.print()},{once:true})</script></html>`);
      popup.document.close();
      toast.success(`${products.length} label${products.length === 1 ? "" : "s"} ready to print`);
    } catch (error) {
      popup.close();
      toast.error(apiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
      <Modal open onClose={onClose} title="Product identification & labels" wide>
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["Identified products", stats?.identified_products ?? "—"],
              ["Missing GS1 EAN-13", stats?.products_missing_ean13 ?? "—"],
              ["Invalid / duplicate codes", stats ? `${stats.invalid_ean13} / ${stats.duplicate_codes}` : "—"],
              ["Recorded scans", stats?.scans_total ?? "—"],
            ].map(([label, value]) => <Card key={label} className="p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold text-slate-800">{value}</p></Card>)}
          </div>

          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <p className="text-sm text-slate-600">New products use the existing company stock record and receive a permanent Product ID, QR payload and SKU.</p>
            <Btn variant="outline" onClick={onCreateProduct}><Plus size={15} /> Add product</Btn>
          </Card>

          <Card className="p-4 space-y-3">
            <h4 className="font-semibold text-slate-800">Scan and identify</h4>
            <BarcodeScanner onScan={scanProduct} disabled={busy} />
            {scanResult && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
              <p><strong>{scanResult.product}</strong> · {scanResult.dimensions}{scanResult.unit ? ` ${scanResult.unit}` : ""} · Available: <strong>{scanResult.current_stock}</strong></p>
              <Btn variant="outline" onClick={() => { onStockMovement?.(scanResult); onClose(); }}><ScanLine size={15} /> Record movement</Btn>
            </div>}
          </Card>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <Input label="Search products" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Name, Product ID, SKU, dimensions or barcode" />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Category" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }} placeholder="Filter category" />
                <Input label="Density" value={densityFilter} onChange={(event) => { setDensityFilter(event.target.value); setPage(1); }} placeholder="Filter density" />
              </div>
              <div className="rounded-lg border border-border bg-slate-50 px-3 py-2 text-xs">
                <span className="text-slate-500">Company scope (server-enforced): </span>
                <strong className="text-slate-700">{companyName}</strong>
                <span className="ml-1 text-slate-400">Switch company in the ERP to access another authorized catalog.</span>
              </div>
              <select aria-label="Filter by product status" value={activeFilter} onChange={(event) => { setActiveFilter(event.target.value); setPage(1); }} className="h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-slate-700">
                <option value="">All statuses</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                {catalogLoading && !catalog.items.length && <p className="p-4 text-sm text-slate-400">Loading products…</p>}
                {catalogError && <p className="p-4 text-sm text-red-600" role="alert">{catalogError}</p>}
                {!catalogLoading && !catalogError && catalog.items.map((item) => <div key={stockIdOf(item)} className="flex items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
                  <input aria-label={`Select label for ${item.product} ${item.dimensions}`} type="checkbox" checked={selectedIds.includes(stockIdOf(item))} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...new Set([...ids, stockIdOf(item)])] : ids.filter((id) => id !== stockIdOf(item)))} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => manageProduct(item)}>
                    <span className="block truncate text-sm font-semibold text-slate-700">{item.product} · {item.dimensions}</span>
                    <span className="block truncate text-xs text-slate-400">{item.sku} · {item.product_id} · {item.company_name}</span>
                  </button>
                  <Btn variant="outline" className="px-2 py-1.5" onClick={() => manageProduct(item)} disabled={busy}>Manage</Btn>
                </div>)}
                {!catalogLoading && !catalogError && !catalog.items.length && <p className="p-4 text-sm text-slate-400">No matching products.</p>}
              </div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{catalog.total} products · Page {catalog.pages ? catalog.page : 0} of {catalog.pages}</span>
                <div className="flex gap-1">
                  <Btn variant="outline" className="px-2 py-1" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous products page"><ChevronLeft size={15} /></Btn>
                  <Btn variant="outline" className="px-2 py-1" disabled={page >= catalog.pages} onClick={() => setPage((value) => value + 1)} aria-label="Next products page"><ChevronRight size={15} /></Btn>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                  <Input label="Label width (mm)" type="number" min="75" max="300" value={labelSize.width} onChange={(event) => setLabelSize((size) => ({ ...size, width: event.target.value }))} />
                  <Input label="Label height (mm)" type="number" min="48" max="300" value={labelSize.height} onChange={(event) => setLabelSize((size) => ({ ...size, height: event.target.value }))} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn variant="outline" disabled={!selectedProducts.length || busy} onClick={printLabels}><Printer size={15} /> Print {selectedProducts.length || ""}</Btn>
                <Btn disabled={!selectedProducts.length || busy} onClick={downloadLabels}><Download size={15} /> Download PDF</Btn>
              </div>
            </div>

            <Card className="p-4">
              {!identity || !draft || !stockDraft ? <div className="flex min-h-56 flex-col items-center justify-center text-center text-sm text-slate-400"><Tag size={28} className="mb-2" />{identityLoading ? "Loading product details…" : "Select a stock product to manage its codes."}</div> : (
                <div className="space-y-3">
                  <div><h4 className="font-semibold text-slate-800">{selectedStock.product} · {selectedStock.size}</h4><p className="font-mono text-xs text-slate-500">{identity.product_id}</p></div>
                  <div className="space-y-3 rounded-lg border border-border p-3">
                    <h5 className="text-sm font-semibold text-slate-800">Stock product details</h5>
                    <Input label="Product name" value={stockDraft.product} onChange={(event) => setStockDraft({ ...stockDraft, product: event.target.value })} />
                    <Input label="Formatted dimensions" value={stockDraft.dimensions} onChange={(event) => setStockDraft({ ...stockDraft, dimensions: event.target.value })} placeholder="910x100" />
                    <p className="text-xs text-slate-500">Dimensions must be numeric (for example 910x100). Existing price entries and stock ledger records stay unchanged; future price lookups use the updated dimensions.</p>
                    <Btn variant="outline" onClick={saveStockDetails} disabled={busy}>Save product details</Btn>
                  </div>
                  <Input label="Description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="SKU" value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} placeholder="Company-prefixed internal code" />
                    <Input label="Category" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder={selectedStock.product} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Density (optional)" value={draft.density} onChange={(event) => setDraft({ ...draft, density: event.target.value })} placeholder="e.g. 16 kg/m³" />
                    <Input label="Product type" value={draft.product_type} onChange={(event) => setDraft({ ...draft, product_type: event.target.value })} placeholder="e.g. Finished foam" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Input label="Length" type="number" min="0" step="any" value={draft.length} onChange={(event) => setDraft({ ...draft, length: event.target.value })} />
                    <Input label="Width" type="number" min="0" step="any" value={draft.width} onChange={(event) => setDraft({ ...draft, width: event.target.value })} />
                    <Input label="Thickness" type="number" min="0" step="any" value={draft.thickness} onChange={(event) => setDraft({ ...draft, thickness: event.target.value })} />
                    <Input label="Unit" value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })} placeholder="mm" />
                  </div>
                  <Input label="EAN-13 / GS1 GTIN (optional)" value={draft.ean13} maxLength={13} inputMode="numeric" onChange={(event) => setDraft({ ...draft, ean13: event.target.value.replace(/[^0-9]/g, "").slice(0, 13) })} placeholder="Enter an allocated 13-digit GTIN" />
                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={draft.gs1_allocated} onChange={(event) => setDraft({ ...draft, gs1_allocated: event.target.checked })} />
                    I confirm this GTIN was allocated by GS1 to my company. The system checks the EAN-13 checksum, not GS1 ownership.
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
                    Product active (turn off to block scans)
                  </label>
                  <Input label="Data Matrix payload (optional)" value={draft.data_matrix_payload} onChange={(event) => setDraft({ ...draft, data_matrix_payload: event.target.value })} placeholder="Leave blank to disable Data Matrix" />
                  <ProductCodePreviews identity={identity} />
                  <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-xs">
                    <p><strong>Internal ID:</strong> <span className="font-mono">{identity.product_id}</span></p>
                    <p><strong>SKU:</strong> <span className="font-mono">{identity.sku}</span></p>
                    <p><strong>Company:</strong> {identity.company_name}</p>
                    <p><strong>EAN-13:</strong> {identity.ean13 || "Not registered — internal codes are not GS1 barcodes"}</p>
                  </div>
                  <Btn onClick={saveIdentity} disabled={busy}><Save size={15} /> Save identification</Btn>
                </div>
              )}
            </Card>
          </div>

          {stats?.most_scanned?.length > 0 && <div><h4 className="mb-2 text-sm font-semibold text-slate-700">Most scanned products</h4><div className="flex flex-wrap gap-2">{stats.most_scanned.map((item) => <span key={item.product_id} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{item.product || item.product_id}: {item.scan_count}</span>)}</div></div>}
        </div>
      </Modal>
  );
}
