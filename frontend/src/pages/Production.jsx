import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtDateTime, today } from "@/lib/format";
import { Card, Btn, Input, Select, Modal, PageHeader, Empty, Badge } from "@/components/common";
import { Factory, Plus, Save, Trash2, Pencil, RotateCcw } from "lucide-react";
import BarcodeScanner from "@/components/BarcodeScanner";

export default function Production() {
  const [data, setData] = useState(null);
  const emptyForm = () => ({ date: today(), blocks: [{ block: "White", quantity: "" }], notes: "" });
  const [form, setForm] = useState(emptyForm);
  const [stock, setStock] = useState([]);
  const [blockCuttings, setBlockCuttings] = useState([]);
  const [cutOpen, setCutOpen] = useState(false);
  const [cutForm, setCutForm] = useState({ block: "", size: "" });
  const [cutScanProduct, setCutScanProduct] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cutBusy, setCutBusy] = useState(false);
  const load = () => {
    api.get("/production/daily").then(setData).catch((e) => toast.error(apiError(e)));
    api.get("/production/block-cutting").then(setBlockCuttings).catch((e) => toast.error(apiError(e)));
    api.get("/stock").then(setStock).catch((e) => toast.error(apiError(e)));
  };
  useEffect(() => { load(); }, []);

  const availableSizes = [...new Set(stock.map((item) => item.size).filter(Boolean))].sort();

  const save = async () => {
    const blocks = form.blocks
      .filter((item) => String(item.quantity).trim() !== "")
      .map((item) => ({ block: item.block.trim(), quantity: Number(item.quantity) }));
    if (!blocks.length || blocks.some((item) => !item.block || !Number.isInteger(item.quantity) || item.quantity < 0)) {
      return toast.error("Enter a block name and a valid non-negative quantity");
    }
    if (busy) return; setBusy(true);
    try {
      await api.post("/production/daily", { ...form, blocks });
      toast.success("Production saved"); setForm(emptyForm()); load();
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const saveBlockCutting = async () => {
    if (!cutForm.block || !cutForm.size) return toast.error("Select a block and size");
    if (cutBusy) return;
    setCutBusy(true);
    try {
      if (cutForm.id) await api.put(`/production/block-cutting/${cutForm.id}`, cutForm);
      else await api.post("/production/block-cutting", cutForm);
      toast.success(cutForm.id ? "Block cutting updated" : "Block cutting recorded");
      setCutOpen(false);
      setCutForm({ block: "", size: "" });
      api.get("/production/block-cutting").then(setBlockCuttings).catch((e) => toast.error(apiError(e)));
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setCutBusy(false);
    }
  };
  const scanCutProduct = async (code) => {
    try {
      const product = await api.post("/products/scan", {
        code,
        scan_id: globalThis.crypto?.randomUUID?.(),
      });
      setCutForm((current) => ({ ...current, size: product.dimensions }));
      setCutScanProduct(product);
      toast.success(`${product.product} · ${product.dimensions} selected`);
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const deleteBlockCutting = async (record) => {
    if (!window.confirm(`Archive the ${record.block} ${record.size} block cutting record?`)) return;
    try {
      await api.del(`/production/block-cutting/${record.id}`);
      toast.success("Block cutting archived");
      setBlockCuttings((current) => current.map((item) => item.id === record.id ? { ...item, archived: true } : item));
    } catch (e) {
      toast.error(apiError(e));
    }
  };
  const restoreBlockCutting = async (record) => {
    try {
      await api.post(`/production/block-cutting/${record.id}/restore`);
      toast.success("Block cutting restored");
      setBlockCuttings((current) => current.map((item) => item.id === record.id ? { ...item, archived: false } : item));
    } catch (e) { toast.error(apiError(e)); }
  };
  const del = async (r) => { if (!window.confirm(`Archive production of ${fmtDate(r.date)}? The record will be retained.`)) return; await api.del(`/production/daily/${r.id}`); load(); };
  const restoreDaily = async (r) => {
    try { await api.post(`/production/daily/${r.id}/restore`); toast.success("Production record restored"); load(); }
    catch (e) { toast.error(apiError(e)); }
  };
  const Tot = ({ l, v, k }) => (
    <Card className="p-4" data-testid={`prod-total-${k}`}><p className="text-xs text-slate-400 uppercase font-semibold">{l}</p>
      <p className="mt-1 font-mono text-slate-800"><span className="text-xl font-bold">{v?.total_blocks || 0}</span> total blocks</p>
      <p className="mt-1 text-xs text-slate-500">{Object.entries(v?.blocks || {}).map(([block, quantity]) => `${block}: ${quantity}`).join(" · ") || "No blocks recorded"}</p></Card>);

  return (
    <div className="space-y-6">
      <PageHeader title="Production" subtitle="Record block quantities produced each day" />
      <Card className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <Input label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} data-testid="prod-date-input" />
          <Input label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} data-testid="prod-notes-input" />
        </div>
        <datalist id="production-block-options"><option value="Black" /><option value="White" /></datalist>
        <div className="mt-4 space-y-3">
          {form.blocks.map((item, index) => (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <Input label="Block" list="production-block-options" value={item.block} onChange={(e) => setForm({ ...form, blocks: form.blocks.map((block, row) => row === index ? { ...block, block: e.target.value } : block) })} data-testid={`prod-block-input-${index}`} />
              <Input label="Quantity" type="number" min="0" step="1" value={item.quantity} onChange={(e) => setForm({ ...form, blocks: form.blocks.map((block, row) => row === index ? { ...block, quantity: e.target.value } : block) })} data-testid={`prod-quantity-input-${index}`} />
              {form.blocks.length > 1 && <Btn variant="outline" onClick={() => setForm({ ...form, blocks: form.blocks.filter((_, row) => row !== index) })} aria-label="Remove block row"><Trash2 size={16} /></Btn>}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Btn variant="outline" onClick={() => setForm({ ...form, blocks: [...form.blocks, { block: "Black", quantity: "" }] })} data-testid="add-production-block-btn"><Plus size={16} /> Add Block</Btn>
            <Btn disabled={busy} onClick={save} data-testid="save-production-btn"><Save size={16} /> Save</Btn>
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-2">Saving the same date again replaces that day's numbers.</p>
      </Card>
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold text-slate-800">Block Cutting</h2><p className="text-sm text-slate-500">Record cut block type and size without changing stock quantities.</p></div>
          <Btn onClick={() => { setCutForm({ block: "", size: "" }); setCutScanProduct(null); setCutOpen(true); }} data-testid="add-block-cutting-btn"><Plus size={16} /> Add Block Cutted</Btn>
        </div>
        {blockCuttings.length === 0 ? <p className="text-sm text-slate-400">No block cutting records yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Block</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Date and Time</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
              <tbody>{blockCuttings.map((record) => <tr key={record.id} className="border-b border-border/70" data-testid={`block-cutting-row-${record.id}`}>
                <td className="px-3 py-2 font-semibold">{record.block}{record.archived && <Badge cls="ml-2 bg-amber-50 text-amber-700 border-amber-200">Archived</Badge>}</td><td className="px-3 py-2">{record.size}</td><td className="px-3 py-2 text-slate-500">{fmtDateTime(record.created_at)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {record.archived ? <button onClick={() => restoreBlockCutting(record)} className="text-emerald-700 hover:text-emerald-900" aria-label={`Restore ${record.block} ${record.size}`} data-testid={`restore-block-cutting-${record.id}`}><RotateCcw size={15} /></button> : <>
                    <button onClick={() => { setCutForm({ id: record.id, block: record.block, size: record.size }); setCutScanProduct(null); setCutOpen(true); }} className="mr-3 text-slate-400 hover:text-primary" aria-label={`Edit ${record.block} ${record.size}`} data-testid={`edit-block-cutting-${record.id}`}><Pencil size={15} /></button>
                    <button onClick={() => deleteBlockCutting(record)} className="text-slate-400 hover:text-red-600" aria-label={`Archive ${record.block} ${record.size}`} data-testid={`delete-block-cutting-${record.id}`}><Trash2 size={15} /></button>
                  </>}
                </td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4"><Tot l="Today" v={data?.today} k="today" /><Tot l="This week" v={data?.week} k="week" /><Tot l="This month" v={data?.month} k="month" /></div>
      <Card className="overflow-hidden">
        {!data ? <p className="p-6 text-sm text-slate-400">Loading...</p> : data.rows.length === 0 ? <Empty icon={Factory} title="No production recorded yet" /> : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-border"><th className="px-4 py-3">Date</th><th className="px-4">Blocks</th><th className="px-4 text-right">Total</th><th className="px-4">Notes</th><th className="px-4" /></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id} className="border-b border-border/60" data-testid={`prod-row-${r.id}`}>
                <td className="px-4 py-3">{fmtDate(r.date)}{r.archived && <Badge cls="ml-2 bg-amber-50 text-amber-700 border-amber-200">Archived</Badge>}</td>
                <td className="px-4 font-mono">{(r.blocks || []).map((item) => `${item.block}: ${item.quantity}`).join(" · ") || "—"}</td>
                <td className="px-4 text-right font-mono font-bold">{r.total_blocks ?? r.white_blocks + r.blue_blocks}</td><td className="px-4 text-slate-500">{r.notes}</td>
                <td className="px-4 text-right">{r.archived ? <button onClick={() => restoreDaily(r)} className="text-emerald-700" aria-label="Restore production record"><RotateCcw size={15} /></button> : <><button onClick={() => setForm({ date: r.date, blocks: r.blocks?.length ? r.blocks.map((item) => ({ ...item, quantity: String(item.quantity) })) : [{ block: "White", quantity: String(r.white_blocks || "") }, { block: "Blue", quantity: String(r.blue_blocks || "") }], notes: r.notes || "" })} className="text-primary text-xs font-semibold mr-3">Edit</button><button onClick={() => del(r)} className="text-slate-400 hover:text-red-600" aria-label="Archive production record"><Trash2 size={15} /></button></>}</td>
              </tr>))}</tbody>
          </table>
          </div>)}
      </Card>
      <Modal open={cutOpen} onClose={() => setCutOpen(false)} title={cutForm.id ? "Edit Block Cutting" : "Add Block Cutted"}>
        <div className="space-y-4">
          <BarcodeScanner onScan={scanCutProduct} disabled={cutBusy} label="Scan a finished product to select its size" />
          {cutScanProduct && <p className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">
            {cutScanProduct.product} · {cutScanProduct.dimensions} · Available stock: {cutScanProduct.current_stock}
          </p>}
          <Input label="Which block?" list="block-cutting-options" value={cutForm.block} onChange={(event) => setCutForm({ ...cutForm, block: event.target.value, size: "" })} placeholder="Choose or type a block" data-testid="block-cutting-type-select" />
          <datalist id="block-cutting-options"><option value="Black" /><option value="White" /></datalist>
          <Select label="Which size?" value={cutForm.size} onChange={(event) => setCutForm({ ...cutForm, size: event.target.value })} disabled={!cutForm.block || availableSizes.length === 0} data-testid="block-cutting-size-select">
            <option value="">{availableSizes.length ? "Select size..." : "No sizes available in Stock"}</option>
            {availableSizes.map((size) => <option key={size} value={size}>{size}</option>)}
          </Select>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setCutOpen(false)}>Cancel</Btn><Btn disabled={cutBusy || !cutForm.block || !cutForm.size} onClick={saveBlockCutting} data-testid="save-block-cutting-btn">Confirm</Btn></div>
        </div>
      </Modal>
    </div>
  );
}
