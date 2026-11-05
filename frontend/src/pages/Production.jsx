import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { fmtDate, fmtDateTime, today } from "@/lib/format";
import { Card, Btn, Input, Select, Modal, PageHeader, Empty, Badge } from "@/components/common";
import { Factory, Plus, Save, Trash2, Pencil, RotateCcw } from "lucide-react";
import BarcodeScanner from "@/components/BarcodeScanner";
import { useAuth } from "@/context/AuthContext";

const unitFactor = (unit = "") => {
  const normalized = unit.trim().toLowerCase();
  if (["g", "gram", "grams"].includes(normalized)) return ["mass", 1];
  if (["kg", "kilogram", "kilograms"].includes(normalized)) return ["mass", 1000];
  if (["ml", "milliliter", "milliliters"].includes(normalized)) return ["volume", 1];
  if (["l", "liter", "liters"].includes(normalized)) return ["volume", 1000];
  return [normalized, 1];
};
export default function Production() {
  const { user } = useAuth();
  const canPermanentlyDelete = user?.is_admin || user?.role === "admin" || user?.is_owner;
  const canRecordBlockProduction = user?.company_id === "iqfoam-manufactoring"
    && (!user?.is_worker || (user?.is_supervisor && user?.allowed_sections?.includes("production")));
  const canManageRecipes = !user?.is_worker && (user?.is_owner || user?.is_admin || user?.is_company_owner);
  const [data, setData] = useState(null);
  const emptyForm = () => ({ date: today(), blocks: [{ block: "White", quantity: "" }], notes: "" });
  const [form, setForm] = useState(emptyForm);
  const [stock, setStock] = useState([]);
  const [blockCuttings, setBlockCuttings] = useState([]);
  const [showArchivedCuttings, setShowArchivedCuttings] = useState(false);
  const [cutOpen, setCutOpen] = useState(false);
  const [cutForm, setCutForm] = useState({
    block: "", size: "", pieces_recovered: "", has_sheet: false,
  });
  const [cutScanProduct, setCutScanProduct] = useState(null);
  const [blockRecipes, setBlockRecipes] = useState([]);
  const [blockProductions, setBlockProductions] = useState([]);
  const [chemicalInventory, setChemicalInventory] = useState([]);
  const [recipePrompt, setRecipePrompt] = useState(null);
  const [recipeEditor, setRecipeEditor] = useState(null);
  const [recipeHistory, setRecipeHistory] = useState(null);
  const [blockProductionSaving, setBlockProductionSaving] = useState(false);
  const [blockRequestId, setBlockRequestId] = useState(() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  const [blockProduction, setBlockProduction] = useState({
    date: today(), recipe_id: "", block_type: "", custom_mode: false, quantity: "1",
    automatic: false, components: [], invoice_reference: "", supplier: "", document_date: "",
  });
  const [recipeDraft, setRecipeDraft] = useState({ block_type: "", components: [], indicated_total_cost: "" });
  const [busy, setBusy] = useState(false);
  const [cutBusy, setCutBusy] = useState(false);
  const load = () => {
    api.get("/production/daily").then(setData).catch((e) => toast.error(apiError(e)));
    api.get(showArchivedCuttings ? "/production/block-cutting?include_archived=true" : "/production/block-cutting")
      .then(setBlockCuttings).catch((e) => toast.error(apiError(e)));
    api.get("/stock").then(setStock).catch((e) => toast.error(apiError(e)));
    if (canRecordBlockProduction) {
      api.getUncached("/production/block-recipes").then(setBlockRecipes).catch((e) => toast.error(apiError(e)));
      api.getUncached("/production/block-productions").then(setBlockProductions).catch((e) => toast.error(apiError(e)));
      api.getUncached("/warehouses/chemical/inventory").then(setChemicalInventory).catch((e) => toast.error(apiError(e)));
    }
  };
  useEffect(() => { load(); }, [showArchivedCuttings, canRecordBlockProduction]);

  const availableSizes = [...new Set(stock.map((item) => item.size).filter(Boolean))].sort();
  const selectedRecipe = blockRecipes.find((recipe) => recipe.id === blockProduction.recipe_id);
  const availableChemicalNames = [...new Set(chemicalInventory.map((item) => item.chemical))].sort();
  const remainingChemicalBase = new Map();
  const productionMaterialSummary = blockProduction.components.map((component) => {
    const required = (Number(component.quantity) || 0) * (Number(blockProduction.quantity) || 0);
    const [kind, factor] = unitFactor(component.unit || "");
    const key = `${component.chemical?.trim().toLowerCase()}|${kind}`;
    if (!component.chemical || !component.unit) return { ...component, required, available: null, missing: null };
    if (!remainingChemicalBase.has(key)) {
      const availableBase = chemicalInventory
        .filter((item) => item.chemical?.trim().toLowerCase() === component.chemical.trim().toLowerCase())
        .reduce((total, item) => {
          const [itemKind, itemFactor] = unitFactor(item.unit);
          if (itemKind !== kind) return total;
          const available = Number(item.available_quantity ?? (item.capacity * item.count - (item.quantity_used || 0)));
          return total + available * itemFactor;
        }, 0);
      remainingChemicalBase.set(key, availableBase);
    }
    const available = remainingChemicalBase.get(key) / factor;
    const requiredBase = required * factor;
    const missing = Math.max(0, requiredBase - remainingChemicalBase.get(key)) / factor;
    remainingChemicalBase.set(key, Math.max(0, remainingChemicalBase.get(key) - requiredBase));
    return {
      ...component,
      required,
      available,
      missing,
    };
  });
  const hasInsufficientChemical = productionMaterialSummary.some((item) =>
    item.available == null || item.missing > 1e-8);
  const knownCostPerBlock = blockProduction.components.reduce(
    (total, component) => total + (component.cost === "" || component.cost == null ? 0 : Number(component.cost) || 0), 0,
  );
  const missingCosts = blockProduction.components
    .filter((component) => component.cost === "" || component.cost == null)
    .map((component) => component.label || component.chemical || "Unnamed material");

  const selectBlockType = (blockType) => {
    const recipe = blockRecipes.find((item) => item.block_type === blockType);
    if (recipe) {
      setRecipePrompt(recipe);
      return;
    }
    setBlockProduction((current) => ({
      ...current, recipe_id: "", block_type: blockType === "CUSTOM / MANUAL FORMULA" ? "" : blockType,
      custom_mode: blockType === "CUSTOM / MANUAL FORMULA", automatic: false,
      components: [{ chemical: "", quantity: "", unit: "", cost: "" }],
    }));
  };

  const chooseRecipeMode = (automatic) => {
    if (!recipePrompt) return;
    const recipe = recipePrompt;
    setBlockProduction((current) => ({
      ...current,
      recipe_id: automatic ? recipe.id : "",
      block_type: recipe.block_type,
      custom_mode: false,
      automatic,
      components: automatic
        ? recipe.components.map((component) => ({
          ...component,
          quantity: String(component.quantity),
          unit: component.unit || "",
          cost: component.cost == null ? "" : String(component.cost),
        }))
        : recipe.components.map((component) => ({
          chemical: component.chemical,
          label: component.label || "",
          quantity: "",
          unit: "",
          cost: "",
        })),
    }));
    setRecipePrompt(null);
  };

  const updateProductionComponent = (index, patch) => setBlockProduction((current) => ({
    ...current,
    components: current.components.map((component, row) => row === index ? { ...component, ...patch } : component),
  }));

  const saveBlockProduction = async () => {
    const quantity = Number(blockProduction.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) return toast.error("Enter a positive number of blocks");
    const components = blockProduction.components.map((component) => ({
      ...component,
      quantity: Number(component.quantity),
      cost: component.cost === "" || component.cost == null ? null : Number(component.cost),
      unit: String(component.unit || "").trim(),
    }));
    if (components.some((component) => !component.chemical.trim() || !Number.isFinite(component.quantity) || component.quantity <= 0 || !component.unit)) {
      return toast.error("Enter a valid chemical, quantity and confirmed unit for every formula line");
    }
    if (components.some((component) => component.cost != null && (!Number.isFinite(component.cost) || component.cost < 0))) {
      return toast.error("Enter valid non-negative component costs");
    }
    setBlockProductionSaving(true);
    try {
      await api.post("/production/block-productions", {
        request_id: blockRequestId,
        date: blockProduction.date,
        recipe_id: blockProduction.recipe_id || null,
        block_type: blockProduction.block_type,
        quantity,
        automatic: blockProduction.automatic,
        components,
        invoice_reference: blockProduction.invoice_reference.trim(),
        supplier: blockProduction.supplier.trim(),
        document_date: blockProduction.document_date || null,
      });
      toast.success("Production recorded; finished stock and chemical usage updated");
      if (blockProduction.custom_mode && window.confirm("Vuoi salvare questa formula per utilizzarla nelle prossime produzioni?")) {
        try {
          await api.post("/production/block-recipes", {
            block_type: blockProduction.block_type,
            components: components.map(({ chemical, quantity, unit, cost, label }) => ({
              chemical, quantity, unit, cost, label,
            })),
            indicated_total_cost: null,
          });
          toast.success("Formula saved for future productions");
          api.getUncached("/production/block-recipes").then(setBlockRecipes).catch((error) => toast.error(apiError(error)));
        } catch (error) {
          toast.error(`Production was recorded, but the formula was not saved: ${apiError(error)}`);
        }
      }
      setBlockProduction({
        date: today(), recipe_id: "", block_type: "", custom_mode: false, quantity: "1",
        automatic: false, components: [], invoice_reference: "", supplier: "", document_date: "",
      });
      setBlockRequestId(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
      load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setBlockProductionSaving(false);
    }
  };

  const openRecipeEditor = (recipe = null) => {
    setRecipeDraft(recipe ? {
      id: recipe.id,
      block_type: recipe.block_type,
      components: recipe.components.map((component) => ({ ...component })),
      indicated_total_cost: recipe.indicated_total_cost == null ? "" : String(recipe.indicated_total_cost),
    } : {
      block_type: "",
      components: [{ chemical: "", quantity: "", unit: "", cost: "" }],
      indicated_total_cost: "",
    });
    setRecipeEditor(true);
  };
  const saveRecipeDraft = async (event) => {
    event.preventDefault();
    const body = {
      block_type: recipeDraft.block_type.trim(),
      components: recipeDraft.components.map((component) => ({
        chemical: component.chemical.trim(),
        quantity: Number(component.quantity),
        unit: String(component.unit || "").trim(),
        unit_confirmation_required: !String(component.unit || "").trim(),
        cost: component.cost === "" || component.cost == null ? null : Number(component.cost),
        label: component.label || "",
      })),
      indicated_total_cost: recipeDraft.indicated_total_cost === "" ? null : Number(recipeDraft.indicated_total_cost),
    };
    if (!body.block_type || !body.components.length || body.components.some((component) =>
      !component.chemical || !Number.isFinite(component.quantity) || component.quantity <= 0
      || (component.cost != null && (!Number.isFinite(component.cost) || component.cost < 0)))) {
      return toast.error("Enter a block name and valid chemical recipe lines");
    }
    try {
      if (recipeDraft.id) await api.put(`/production/block-recipes/${recipeDraft.id}`, body);
      else await api.post("/production/block-recipes", body);
      toast.success(recipeDraft.id ? "Recipe updated; previous production records are unchanged" : "Recipe saved");
      setRecipeEditor(false);
      api.getUncached("/production/block-recipes").then(setBlockRecipes).catch((error) => toast.error(apiError(error)));
    } catch (error) {
      toast.error(apiError(error));
    }
  };
  const viewRecipeHistory = async (recipe) => {
    try {
      const entries = await api.get(`/production/block-recipes/${recipe.id}/history`);
      setRecipeHistory({ recipe, entries });
    } catch (error) {
      toast.error(apiError(error));
    }
  };

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
    if (!cutForm.block || (!cutForm.has_sheet && !cutForm.size)) {
      return toast.error(cutForm.has_sheet ? "Select a block" : "Select a block and size");
    }
    const piecesRecovered = Number(cutForm.pieces_recovered);
    if (!Number.isInteger(piecesRecovered) || piecesRecovered <= 0) {
      return toast.error("Enter a positive whole number of pieces recovered");
    }
    if (cutBusy) return;
    setCutBusy(true);
    try {
      const payload = {
        ...cutForm,
        size: cutForm.has_sheet ? "" : cutForm.size,
        pieces_recovered: piecesRecovered,
      };
      if (cutForm.id) await api.put(`/production/block-cutting/${cutForm.id}`, payload);
      else await api.post("/production/block-cutting", payload);
      toast.success(cutForm.id ? "Block cutting updated" : "Block cutting recorded");
      setCutOpen(false);
      setCutForm({ block: "", size: "", pieces_recovered: "", has_sheet: false });
      api.get(showArchivedCuttings ? "/production/block-cutting?include_archived=true" : "/production/block-cutting")
        .then(setBlockCuttings).catch((e) => toast.error(apiError(e)));
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
      setBlockCuttings((current) => showArchivedCuttings
        ? current.map((item) => item.id === record.id ? { ...item, archived: true } : item)
        : current.filter((item) => item.id !== record.id));
    } catch (e) {
      toast.error(apiError(e));
    }
  };
  const permanentlyDeleteBlockCutting = async (record) => {
    if (!record.archived) return;
    if (!window.confirm(`Permanently delete the ${record.block} ${record.size} block cutting record? This cannot be undone.`)) return;
    try {
      await api.del(`/production/block-cutting/${record.id}/permanent`);
      toast.success("Block cutting permanently deleted");
      setBlockCuttings((current) => current.filter((item) => item.id !== record.id));
    } catch (e) {
      toast.error(apiError(e));
    }
  };
  const restoreBlockCutting = async (record) => {
    try {
      await api.post(`/production/block-cutting/${record.id}/restore`);
      toast.success("Block cutting restored");
      setBlockCuttings((current) => showArchivedCuttings
        ? current.filter((item) => item.id !== record.id)
        : current.map((item) => item.id === record.id ? { ...item, archived: false } : item));
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
      {canRecordBlockProduction && <Card className="p-5 space-y-4" data-testid="block-production-card">
        <div>
          <h2 className="font-semibold text-slate-800">Production Warehouse · Block production</h2>
          <p className="text-sm text-slate-500">Confirm production to add finished blocks to Stock and record actual chemical usage.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select label="Block type" value={blockProduction.custom_mode ? "CUSTOM / MANUAL FORMULA" : blockProduction.block_type} onChange={(event) => selectBlockType(event.target.value)} data-testid="block-production-type">
            <option value="">Select block type</option>
            {[...new Set([...blockRecipes.map((recipe) => recipe.block_type), "BIG BLOCK 2750", "MED 2350", "SMALL 2150", "CUSTOM / MANUAL FORMULA"])].map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
          {blockProduction.custom_mode && <Input label="Custom block name" value={blockProduction.block_type} onChange={(event) => setBlockProduction({ ...blockProduction, block_type: event.target.value })} data-testid="custom-block-name" />}
          <Input label="Production date" type="date" value={blockProduction.date} max={today()} onChange={(event) => setBlockProduction({ ...blockProduction, date: event.target.value })} data-testid="block-production-date" />
          <Input label="Number of blocks" type="number" min="1" step="1" value={blockProduction.quantity} onChange={(event) => setBlockProduction({ ...blockProduction, quantity: event.target.value })} data-testid="block-production-quantity" />
        </div>
        {blockProduction.components.length > 0 && <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700">{blockProduction.automatic ? "Saved formula · review before confirming" : "Manual formula entry"}</h3>
            {blockProduction.components.map((component, index) => (
              <div key={`${component.chemical}-${index}`} className="grid grid-cols-2 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto] gap-2 items-end" data-testid={`block-formula-line-${index}`}>
                {blockProduction.automatic
                  ? <Input label="Chemical" value={component.chemical} readOnly />
                  : <Select label="Chemical" value={component.chemical} onChange={(event) => {
                    const chemical = event.target.value;
                    const unit = chemicalInventory.find((item) => item.chemical === chemical)?.unit || "";
                    updateProductionComponent(index, { chemical, unit });
                  }} data-testid={`block-formula-chemical-${index}`}>
                    <option value="">Select chemical in inventory</option>
                    {availableChemicalNames.map((chemical) => <option key={chemical} value={chemical}>{chemical}</option>)}
                  </Select>}
                <Input label={component.unit_confirmation_required ? "Quantity per block (confirm from document)" : "Quantity per block"} type="number" min="0" step="any" value={component.quantity} onChange={(event) => updateProductionComponent(index, { quantity: event.target.value })} readOnly={blockProduction.automatic && !component.unit_confirmation_required} />
                {blockProduction.automatic
                  ? <Input label={component.unit_confirmation_required ? "Unit (confirm from document)" : "Unit"} value={component.unit} onChange={(event) => updateProductionComponent(index, { unit: event.target.value })} readOnly={!component.unit_confirmation_required} placeholder="Confirm unit" data-testid={`block-formula-unit-${index}`} />
                  : <Select label="Unit" value={component.unit} onChange={(event) => updateProductionComponent(index, { unit: event.target.value })} data-testid={`block-formula-unit-${index}`}>
                    <option value="">Select unit</option>
                    {[...new Set(chemicalInventory.filter((item) => item.chemical === component.chemical).map((item) => item.unit))].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                  </Select>}
                <Input label="Cost per block (R)" type="number" min="0" step="0.01" value={component.cost} onChange={(event) => updateProductionComponent(index, { cost: event.target.value })} readOnly={blockProduction.automatic} />
                {!blockProduction.automatic && <Btn variant="outline" onClick={() => setBlockProduction((current) => ({ ...current, components: current.components.filter((_, row) => row !== index) }))} aria-label="Remove formula line"><Trash2 size={15} /></Btn>}
              </div>
            ))}
            {!blockProduction.automatic && <Btn variant="outline" onClick={() => setBlockProduction((current) => ({ ...current, components: [...current.components, { chemical: "", quantity: "", unit: "", cost: "" }] }))} data-testid="add-manual-formula-line"><Plus size={15} /> Add chemical</Btn>}
          </div>
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white p-3" data-testid="production-chemical-summary">
            <h4 className="mb-2 text-sm font-semibold text-slate-700">Required stock for {Number(blockProduction.quantity) || 0} block(s)</h4>
            <table className="w-full min-w-[520px] text-sm">
              <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">Chemical</th><th>Required</th><th>Available</th><th>Missing</th></tr></thead>
              <tbody>{productionMaterialSummary.map((item, index) => (
                <tr key={`${item.chemical}-${index}`} className="border-b last:border-0">
                  <td className="py-2">{item.chemical || "Select chemical"}</td>
                  <td>{item.required.toLocaleString()} {item.unit}</td>
                  <td>{item.available == null ? "Confirm unit / stock" : `${item.available.toLocaleString()} ${item.unit}`}</td>
                  <td className={item.missing > 1e-8 ? "font-semibold text-red-700" : "text-emerald-700"}>
                    {item.missing == null ? "—" : `${item.missing.toLocaleString()} ${item.unit}`}
                  </td>
                </tr>
              ))}</tbody>
            </table>
            {hasInsufficientChemical && <p className="mt-2 text-xs font-medium text-red-700">Production cannot be confirmed until each unit is confirmed and sufficient chemical stock is available.</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="Invoice / document reference" value={blockProduction.invoice_reference} onChange={(event) => setBlockProduction({ ...blockProduction, invoice_reference: event.target.value })} />
            <Input label="Supplier" value={blockProduction.supplier} onChange={(event) => setBlockProduction({ ...blockProduction, supplier: event.target.value })} />
            <Input label="Document date" type="date" max={today()} value={blockProduction.document_date} onChange={(event) => setBlockProduction({ ...blockProduction, document_date: event.target.value })} />
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            <p>Known cost per block: <b>R {knownCostPerBlock.toFixed(2)}</b> · Known production cost: <b>R {(knownCostPerBlock * (Number(blockProduction.quantity) || 0)).toFixed(2)}</b></p>
            {selectedRecipe?.indicated_total_cost != null && <p className="mt-1">Company indicated formula cost: <b>R {Number(selectedRecipe.indicated_total_cost).toFixed(2)}</b></p>}
            {missingCosts.length > 0 && <p className="mt-1 text-amber-700">Cost incomplete; no value is estimated for: {missingCosts.join(", ")}.</p>}
            {blockProduction.components.some((component) => component.unit_confirmation_required && !component.unit) && <p className="mt-1 text-amber-700">TDI MED 2350 is recorded as 28.00 with unit unconfirmed. Confirm its unit from the source document; no conversion will be applied.</p>}
          </div>
          <Btn disabled={blockProductionSaving || hasInsufficientChemical} onClick={saveBlockProduction} data-testid="confirm-block-production">
            <Save size={16} /> {blockProductionSaving ? "Recording..." : "Confirm production"}
          </Btn>
        </>}
        {blockProductions.length > 0 && <div className="overflow-x-auto">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Recent block production records</h3>
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">Reference</th><th>Date</th><th>Block</th><th>Supervisor</th><th className="text-right">Quantity</th><th className="text-right">Known cost</th><th>Cost status</th></tr></thead>
            <tbody>{blockProductions.slice(0, 20).map((record) => <tr key={record.id} className="border-b">
              <td className="py-2 font-mono">{record.reference}</td><td>{record.date}</td><td>{record.block_type}</td><td>{record.supervisor_name}</td>
              <td className="text-right">{record.quantity}</td><td className="text-right">R {Number(record.known_total_cost || 0).toFixed(2)}</td>
              <td>{record.cost_complete ? "Complete" : `Incomplete: ${(record.missing_cost_components || []).join(", ")}`}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </Card>}
      {canManageRecipes && canRecordBlockProduction && <Card className="p-5" data-testid="production-recipe-library">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-slate-800">Saved production recipes</h2>
            <p className="text-xs text-slate-500">Recipe edits apply to future production only; each production keeps its formula snapshot.</p>
          </div>
          <Btn onClick={() => openRecipeEditor()} data-testid="add-production-recipe"><Plus size={15} /> Add recipe</Btn>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b text-left text-xs text-slate-500"><th className="py-2">Block type</th><th>Formula</th><th>Recipe cost</th><th>Version</th><th /></tr></thead>
            <tbody>{blockRecipes.map((recipe) => (
              <tr key={recipe.id} className="border-b last:border-0">
                <td className="py-2 font-semibold">{recipe.block_type}</td>
                <td>{recipe.components.map((component) => `${component.chemical}: ${component.quantity} ${component.unit || "(unit unconfirmed)"}`).join(" · ")}</td>
                <td>{recipe.indicated_total_cost == null ? "Incomplete" : `R ${Number(recipe.indicated_total_cost).toFixed(2)}`}</td>
                <td>{recipe.version || 1}</td>
                <td className="space-x-3 text-right whitespace-nowrap">
                  <button type="button" className="text-primary hover:underline" onClick={() => viewRecipeHistory(recipe)}>History</button>
                  <button type="button" className="text-primary hover:underline" onClick={() => openRecipeEditor(recipe)} aria-label={`Edit ${recipe.block_type} recipe`}><Pencil size={14} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>}
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold text-slate-800">Block Cutting</h2><p className="text-sm text-slate-500">Record cut block type and size without changing stock quantities.</p></div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={showArchivedCuttings} onChange={(event) => setShowArchivedCuttings(event.target.checked)} data-testid="show-archived-block-cuttings" />
              Show archived
            </label>
            <Btn onClick={() => { setCutForm({ block: "", size: "", pieces_recovered: "", has_sheet: false }); setCutScanProduct(null); setCutOpen(true); }} data-testid="add-block-cutting-btn"><Plus size={16} /> Add Block Cutted</Btn>
          </div>
        </div>
        {blockCuttings.length === 0 ? <p className="text-sm text-slate-400">{showArchivedCuttings ? "No archived block cutting records." : "No block cutting records yet."}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead><tr className="border-b border-border bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">Block</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Pieces recovered</th><th className="px-3 py-2">Sheet</th><th className="px-3 py-2">Date and Time</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
              <tbody>{blockCuttings.map((record) => <tr key={record.id} className="border-b border-border/70" data-testid={`block-cutting-row-${record.id}`}>
                <td className="px-3 py-2 font-semibold">{record.block}{record.archived && <Badge cls="ml-2 bg-amber-50 text-amber-700 border-amber-200">Archived</Badge>}</td>
                <td className="px-3 py-2">{record.size || (record.has_sheet ? "Sheet" : "—")}</td>
                <td className="px-3 py-2">{record.pieces_recovered ?? "—"}</td>
                <td className="px-3 py-2">{record.has_sheet ? (record.sheet_mm && record.sheet_pieces_recovered
                  ? `${record.sheet_mm} mm · ${record.sheet_pieces_recovered} pcs`
                  : "Yes") : "—"}</td>
                <td className="px-3 py-2 text-slate-500">{fmtDateTime(record.created_at)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {record.archived ? <>
                    <button onClick={() => restoreBlockCutting(record)} className="mr-3 text-emerald-700 hover:text-emerald-900" aria-label={`Restore ${record.block} ${record.size}`} data-testid={`restore-block-cutting-${record.id}`}><RotateCcw size={15} /></button>
                    {canPermanentlyDelete && <button onClick={() => permanentlyDeleteBlockCutting(record)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50" aria-label={`Permanently delete ${record.block} ${record.size}`} data-testid={`permanently-delete-block-cutting-${record.id}`}><Trash2 size={12} /><span>Delete permanently</span></button>}
                  </> : <>
                    <button onClick={() => { setCutForm({
                      id: record.id, block: record.block, size: record.size,
                      pieces_recovered: record.pieces_recovered == null ? "" : String(record.pieces_recovered),
                      has_sheet: !!record.has_sheet,
                    }); setCutScanProduct(null); setCutOpen(true); }} className="mr-3 text-slate-400 hover:text-primary" aria-label={`Edit ${record.block} ${record.size}`} data-testid={`edit-block-cutting-${record.id}`}><Pencil size={15} /></button>
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
          <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-slate-700">
            <input type="checkbox" checked={!!cutForm.has_sheet} onChange={(event) => setCutForm({
              ...cutForm, has_sheet: event.target.checked,
            })} data-testid="block-cutting-sheet-toggle" />
            Sheet
          </label>
          {!cutForm.has_sheet && <Select label="Which size?" value={cutForm.size} onChange={(event) => setCutForm((current) => ({ ...current, size: event.target.value }))} disabled={availableSizes.length === 0} data-testid="block-cutting-size-select">
            <option value="">{availableSizes.length ? "Select size..." : "No sizes available in Stock"}</option>
            {availableSizes.map((size) => <option key={size} value={size}>{size}</option>)}
          </Select>}
          <Input label={cutForm.has_sheet ? "Pieces recovered from sheet" : "Pieces recovered from this block"} type="number" min="1" step="1" value={cutForm.pieces_recovered} onChange={(event) => setCutForm({ ...cutForm, pieces_recovered: event.target.value })} required data-testid="block-cutting-pieces-recovered" />
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setCutOpen(false)}>Cancel</Btn><Btn disabled={cutBusy || !cutForm.block || (!cutForm.has_sheet && !cutForm.size)} onClick={saveBlockCutting} data-testid="save-block-cutting-btn">Confirm</Btn></div>
        </div>
      </Modal>
      <Modal open={!!recipePrompt} onClose={() => setRecipePrompt(null)} title="Company formula">
        {recipePrompt && <div className="space-y-4">
          <p className="text-sm text-slate-700">Vuoi inserimento automatico per il blocco selezionato? Alcune formule sono salvate sul gestionale aziendale e questo rientra in queste.</p>
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => chooseRecipeMode(false)} data-testid="recipe-manual-no">NO</Btn>
            <Btn onClick={() => chooseRecipeMode(true)} data-testid="recipe-automatic-yes">YES</Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={recipeEditor} onClose={() => setRecipeEditor(false)} title={recipeDraft.id ? "Edit production recipe" : "Add production recipe"} wide>
        <form className="space-y-4" onSubmit={saveRecipeDraft} data-testid="production-recipe-editor">
          <Input label="Block name / reference" value={recipeDraft.block_type} onChange={(event) => setRecipeDraft((current) => ({ ...current, block_type: event.target.value }))} required />
          {recipeDraft.components.map((component, index) => {
            const units = [...new Set(chemicalInventory.filter((item) => item.chemical === component.chemical).map((item) => item.unit))];
            return <div key={index} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto] items-end">
              <Select label="Chemical" value={component.chemical} onChange={(event) => {
                const chemical = event.target.value;
                const unit = chemicalInventory.find((item) => item.chemical === chemical)?.unit || "";
                setRecipeDraft((current) => ({ ...current, components: current.components.map((row, i) => i === index ? { ...row, chemical, unit } : row) }));
              }} required>
                <option value="">Select chemical</option>
                {availableChemicalNames.map((chemical) => <option key={chemical} value={chemical}>{chemical}</option>)}
                {!availableChemicalNames.includes(component.chemical) && component.chemical && <option value={component.chemical}>{component.chemical} (not currently stocked)</option>}
              </Select>
              <Input label="Quantity per block" type="number" min="0" step="any" value={component.quantity} onChange={(event) => setRecipeDraft((current) => ({ ...current, components: current.components.map((row, i) => i === index ? { ...row, quantity: event.target.value } : row) }))} required />
              <Select label="Unit" value={component.unit || ""} onChange={(event) => setRecipeDraft((current) => ({ ...current, components: current.components.map((row, i) => i === index ? { ...row, unit: event.target.value } : row) }))}>
                <option value="">Unit unconfirmed</option>
                {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </Select>
              <Input label="Recipe cost (R)" type="number" min="0" step="0.01" value={component.cost ?? ""} onChange={(event) => setRecipeDraft((current) => ({ ...current, components: current.components.map((row, i) => i === index ? { ...row, cost: event.target.value } : row) }))} />
              <Btn type="button" variant="outline" aria-label="Remove recipe ingredient" onClick={() => setRecipeDraft((current) => ({ ...current, components: current.components.filter((_, i) => i !== index) }))}><Trash2 size={14} /></Btn>
            </div>;
          })}
          <Btn type="button" variant="outline" onClick={() => setRecipeDraft((current) => ({ ...current, components: [...current.components, { chemical: "", quantity: "", unit: "", cost: null }] }))}><Plus size={15} /> Add ingredient</Btn>
          <Input label="Indicated total recipe cost (R)" type="number" min="0" step="0.01" value={recipeDraft.indicated_total_cost} onChange={(event) => setRecipeDraft((current) => ({ ...current, indicated_total_cost: event.target.value }))} />
          <div className="flex justify-end gap-2"><Btn type="button" variant="outline" onClick={() => setRecipeEditor(false)}>Cancel</Btn><Btn type="submit"><Save size={15} /> Save recipe</Btn></div>
        </form>
      </Modal>
      <Modal open={!!recipeHistory} onClose={() => setRecipeHistory(null)} title={`${recipeHistory?.recipe.block_type || "Recipe"} history`} wide>
        {recipeHistory && (recipeHistory.entries.length === 0
          ? <p className="text-sm text-slate-500">No prior versions recorded.</p>
          : <div className="space-y-3">{recipeHistory.entries.map((entry) => (
            <div key={`${entry.recipe_id}-${entry.version}`} className="rounded-md border p-3">
              <p className="font-semibold">Version {entry.version} · {fmtDateTime(entry.changed_at)}</p>
              <p className="text-xs text-slate-600">{entry.recipe.components.map((component) => `${component.chemical}: ${component.quantity} ${component.unit || "(unit unconfirmed)"}`).join(" · ")}</p>
            </div>
          ))}</div>)}
      </Modal>
    </div>
  );
}
