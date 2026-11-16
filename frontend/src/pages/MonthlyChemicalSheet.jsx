import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Download, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Btn, Card, Input, PageHeader, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import { downloadMonthlyChemicalSheetPdf } from "@/lib/monthlyChemicalSheetPdf.mjs";
import {
  calculateMonthlySheet,
  createBlankMonthlySheet,
  MONTHLY_SHEET_BLOCKS,
  MONTHLY_SHEET_CHEMICALS,
  monthlySheetPayload,
} from "@/lib/monthlyChemicalSheet.mjs";

const displayQty = (value) => value == null
  ? "—"
  : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
const cellValue = (value) => value == null ? "" : String(value);

function hydrateSheet(month, saved) {
  const blank = createBlankMonthlySheet(month, saved?.formula_rates || {});
  return {
    ...blank,
    arrivals: Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [
      key, cellValue(saved?.arrivals?.[key]),
    ])),
    minimums: Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [
      key, cellValue(saved?.minimums?.[key]),
    ])),
    arrival_sources: saved?.arrival_sources || [],
    formula_rates: Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key: blockKey }) => [
      blockKey,
      Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey }) => [
        chemicalKey, cellValue(saved?.formula_rates?.[blockKey]?.[chemicalKey]),
      ])),
    ])),
    weeks: blank.weeks.map((week, index) => ({
      ...week,
      ...Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
        key,
        {
          quantity: cellValue(saved?.weeks?.[index]?.[key]?.quantity),
          weight_kg: cellValue(saved?.weeks?.[index]?.[key]?.weight_kg),
        },
      ])),
    })),
  };
}

function NumberCell({ label, value, onChange, disabled, testId, step = "any" }) {
  return (
    <input
      aria-label={label}
      className="w-full min-w-20 rounded border border-slate-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums disabled:bg-slate-50"
      type="number"
      min="0"
      step={step}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      data-testid={testId}
    />
  );
}

function suggestedChemical(product) {
  const name = String(product || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name.includes("ppg") || name.includes("poliol")) return "ppg";
  if (name.includes("tdi") || name.includes("isocianato")) return "tdi";
  if (name.includes("t9") || name.includes("catalizzatore")) return "t9";
  if (name.includes("silicone")) return "silicone";
  if (name.includes("amine52") || name.includes("amina52")) return "amine52";
  if (name === "mcl" || name.includes("mcl")) return "mcl";
  return "";
}

export default function MonthlyChemicalSheet() {
  const { user } = useAuth();
  const companyId = user?._active_company_id || user?.company_id;
  const canEdit = user?.is_primary_owner && user?.is_owner && !user?.is_worker;
  const [month, setMonth] = useState(today().slice(0, 7));
  const [sheet, setSheet] = useState(() => createBlankMonthlySheet(today().slice(0, 7)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [grvs, setGrvs] = useState([]);
  const [grvLoading, setGrvLoading] = useState(false);
  const [grvError, setGrvError] = useState("");
  const [grvReload, setGrvReload] = useState(0);
  const [selectedGrvId, setSelectedGrvId] = useState("");
  const [grvMappings, setGrvMappings] = useState({});

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    api.getUncached("/production/monthly-chemical-sheet", { month })
      .then((saved) => {
        if (active) setSheet(hydrateSheet(month, saved));
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(apiError(error));
        toast.error(`Could not load monthly sheet: ${apiError(error)}`);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month]);

  useEffect(() => {
    let active = true;
    setGrvLoading(true);
    setGrvError("");
    setSelectedGrvId("");
    api.getUncached("/production/monthly-chemical-sheet/grvs", { month })
      .then((records) => {
        if (active) setGrvs(Array.isArray(records) ? records : []);
      })
      .catch((error) => {
        if (!active) return;
        setGrvs([]);
        setGrvError(apiError(error));
        toast.error(`Could not load chemical GRVs: ${apiError(error)}`);
      })
      .finally(() => { if (active) setGrvLoading(false); });
    return () => { active = false; };
  }, [month, grvReload]);

  useEffect(() => {
    if (!grvs.length) return;
    setSheet((current) => {
      let changed = false;
      const arrival_sources = current.arrival_sources.map((source) => {
        const grv = grvs.find((item) => item.id === source.grv_id);
        if (!grv) return source;
        const lines = source.lines.map((line) => {
          if (line.container_capacity != null && line.container_count != null && line.unit) return line;
          const grvLine = grv.items.find((item) => item.line_index === line.line_index);
          if (!grvLine) return line;
          changed = true;
          return {
            ...line,
            product: line.product || grvLine.product,
            container_type: grvLine.container_type,
            container_capacity: grvLine.capacity,
            container_count: grvLine.accepted_quantity,
            unit: grvLine.unit,
            quantity_kg: grvLine.quantity_kg ?? line.quantity_kg,
          };
        });
        return lines === source.lines ? source : { ...source, lines };
      });
      return changed ? { ...current, arrival_sources } : current;
    });
  }, [grvs]);

  const selectedGrv = grvs.find((grv) => grv.id === selectedGrvId);
  const totals = useMemo(() => calculateMonthlySheet(sheet), [sheet]);
  const updateSheet = (update) => setSheet((current) => ({ ...current, ...update }));
  const updateArrival = (key, value) => updateSheet({
    arrivals: { ...sheet.arrivals, [key]: value },
  });
  const updateMinimum = (key, value) => updateSheet({
    minimums: { ...sheet.minimums, [key]: value },
  });
  const updateRate = (blockKey, chemicalKey, value) => updateSheet({
    formula_rates: {
      ...sheet.formula_rates,
      [blockKey]: { ...sheet.formula_rates[blockKey], [chemicalKey]: value },
    },
  });
  const updateProduction = (weekIndex, blockKey, field, value) => updateSheet({
    weeks: sheet.weeks.map((week, index) => index !== weekIndex
      ? week
      : { ...week, [blockKey]: { ...week[blockKey], [field]: value } }),
  });

  const save = async () => {
    if (!canEdit) {
      toast.error("Only the primary owner can save SuperIQFoam company data.");
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put("/production/monthly-chemical-sheet", monthlySheetPayload(sheet));
      setSheet(hydrateSheet(month, saved));
      toast.success("Monthly production sheet saved");
    } catch (error) {
      toast.error(`Could not save monthly sheet: ${apiError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const addSelectedGrv = () => {
    if (!selectedGrv) return;
    if (sheet.arrival_sources.some((source) => source.grv_id === selectedGrv.id)) {
      toast.error("This GRV is already included in the monthly sheet.");
      return;
    }
    const lines = selectedGrv.items
      .filter((line) => grvMappings[line.line_index] && line.quantity_kg > 0)
      .map((line) => ({
        line_index: line.line_index,
        chemical_key: grvMappings[line.line_index],
        product: line.product,
        container_type: line.container_type,
        container_capacity: line.capacity,
        container_count: line.accepted_quantity,
        unit: line.unit,
        quantity_kg: line.quantity_kg,
      }));
    if (!lines.length) {
      toast.error("Map at least one GRV line with a valid kg capacity before adding it.");
      return;
    }
    updateSheet({ arrival_sources: [...sheet.arrival_sources, {
      grv_id: selectedGrv.id,
      grv_number: selectedGrv.grv_number,
      received_date: selectedGrv.received_date,
      supplier_name: selectedGrv.supplier_name,
      lines,
    }] });
    setSelectedGrvId("");
    toast.success(`${selectedGrv.grv_number} added to this month's chemical arrivals.`);
  };

  const removeArrivalSource = (grvId) => updateSheet({
    arrival_sources: sheet.arrival_sources.filter((source) => source.grv_id !== grvId),
  });

  const resetMonth = async () => {
    if (!window.confirm(
      `Reset ${month}? This clears manual arrivals, imported GRVs and weekly production. Verified formula rates and reorder thresholds will be kept.`,
    )) return;
    if (!canEdit) return;
    setSaving(true);
    try {
      const resetSheet = {
        ...createBlankMonthlySheet(month, sheet.formula_rates),
        minimums: sheet.minimums,
      };
      const saved = await api.put("/production/monthly-chemical-sheet", monthlySheetPayload(resetSheet));
      setSheet(hydrateSheet(month, saved));
      toast.success(`Monthly sheet ${month} reset`);
    } catch (error) {
      toast.error(`Could not reset monthly sheet: ${apiError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const exportPdf = async () => {
    try {
      await downloadMonthlyChemicalSheetPdf(sheet, totals);
    } catch (error) {
      toast.error(`Could not create monthly sheet PDF: ${apiError(error)}`);
    }
  };

  if (companyId !== "superiqfoam") {
    return <Card className="p-6"><p className="font-semibold text-red-700">This sheet is only available in the SUPERIQFOAM profile.</p></Card>;
  }

  return (
    <div className="space-y-5" data-testid="monthly-chemical-sheet">
      <PageHeader
        title="Monthly Production & Chemical Balance"
        subtitle="Enter monthly chemical arrivals and weekly production totals. The number of weeks matches the selected calendar month."
      >
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
          <Input label="Month" type="month" value={month} onChange={(event) => setMonth(event.target.value)}
            className="min-w-[170px] border-slate-400 bg-white font-semibold text-slate-900"
            data-testid="monthly-sheet-month" />
          <Btn variant="outline" onClick={exportPdf} disabled={loading || !!loadError} data-testid="monthly-sheet-pdf">
            <Download size={16} /> Download PDF
          </Btn>
          <Btn variant="danger" onClick={resetMonth} disabled={loading || saving || !canEdit || !!loadError} data-testid="monthly-sheet-reset">
            <RotateCcw size={16} /> RESET
          </Btn>
          <Btn onClick={save} disabled={loading || saving || !canEdit || !!loadError} data-testid="monthly-sheet-save">
            <Save size={16} /> {saving ? "Saving..." : "Save sheet"}
          </Btn>
        </div>
      </PageHeader>

      {loadError && <Card className="border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        The saved sheet could not be loaded. Editing is disabled until it can be loaded successfully, to avoid replacing saved data with blanks.
      </Card>}
      {!canEdit && <Card className="border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        This sheet is read-only for this account. The primary owner can enter and save data.
      </Card>}

      <Card className="overflow-hidden">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">1. Chemical arrivals this month (kg)</h2>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[780px] border-collapse text-sm">
            <thead><tr>
              <th className="border bg-[#f7ead1] p-2 text-left">Chemical</th>
              {MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => <th key={key} className="border bg-[#f7ead1] p-2">{label}</th>)}
            </tr></thead>
            <tbody>
              <tr>
                <th className="border bg-[#f8ecd5] p-2 text-left">Manual arrivals (kg)</th>
                {MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => <td key={key} className="border p-2">
                  <NumberCell label={`${label} manual arrivals in kg`} value={sheet.arrivals[key]} disabled={!canEdit || loading || !!loadError}
                    onChange={(value) => updateArrival(key, value)} testId={`monthly-arrival-${key}`} />
                </td>)}
              </tr>
              <tr data-testid="monthly-sheet-grv-arrival-totals">
                <th className="border bg-slate-50 p-2 text-left">Imported from GRVs (kg)</th>
                {MONTHLY_SHEET_CHEMICALS.map(({ key }) => <td key={key}
                  className="border bg-slate-50 p-2 text-right tabular-nums"
                  data-testid={`monthly-arrival-grv-${key}`}>
                  {displayQty(totals.chemicalBalances[key].importedArrival)}
                </td>)}
              </tr>
              <tr className="font-bold" data-testid="monthly-sheet-arrival-totals">
                <th className="border bg-[#f8ecd5] p-2 text-left">Total arrivals (kg)</th>
                {MONTHLY_SHEET_CHEMICALS.map(({ key }) => <td key={key}
                  className="border bg-[#f8ecd5] p-2 text-right tabular-nums"
                  data-testid={`monthly-arrival-total-${key}`}>
                  {displayQty(totals.chemicalBalances[key].arrival)}
                </td>)}
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-right text-sm font-semibold">
            Combined total arrivals: {displayQty(totals.totalArrivals)} kg
          </p>
        </div>
        <div className="space-y-3 border-t border-slate-200 p-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Select label="Import chemical receipt from GRV" value={selectedGrvId}
              disabled={!canEdit || grvLoading || !!grvError || !grvs.length}
              onChange={(event) => {
                const nextId = event.target.value;
                setSelectedGrvId(nextId);
                const record = grvs.find((grv) => grv.id === nextId);
                setGrvMappings(Object.fromEntries((record?.items || []).map((line) => [
                  line.line_index,
                  line.quantity_kg > 0 ? suggestedChemical(line.product) : "",
                ])));
              }}
              data-testid="monthly-sheet-grv-select">
              <option value="">{grvLoading ? "Loading GRVs..." : "Select a confirmed chemical GRV"}</option>
              {grvs.filter((grv) => !sheet.arrival_sources.some((source) => source.grv_id === grv.id))
                .map((grv) => <option key={grv.id} value={grv.id}>
                  {grv.grv_number} · {grv.received_date} · {grv.supplier_name}
                </option>)}
            </Select>
            <Btn type="button" onClick={addSelectedGrv} disabled={!canEdit || !selectedGrv || loading || !!loadError}
              data-testid="monthly-sheet-add-grv">
              <Plus size={16} /> Add GRV
            </Btn>
          </div>
          {grvError && <p className="text-sm text-red-700" role="alert">
            Could not load GRVs: {grvError}
            <button type="button" className="ml-2 font-semibold underline" onClick={() => setGrvReload((value) => value + 1)}>Retry</button>
          </p>}
          {selectedGrv && <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-sm">
              <thead><tr>{["GRV line", "Container", "Accepted", "Capacity each", "Unit", "Imported amount", "Chemical"].map((header) =>
                <th key={header} className="border bg-slate-50 p-2 text-left">{header}</th>)}</tr></thead>
              <tbody>{selectedGrv.items.map((line) => <tr key={line.line_index}>
                <td className="border p-2">{line.product}</td>
                <td className="border p-2">{line.container_type || "Container"}</td>
                <td className="border p-2 text-right">{displayQty(line.accepted_quantity)}</td>
                <td className="border p-2 text-right">{displayQty(line.capacity)}</td>
                <td className="border p-2">{line.unit || "—"}</td>
                <td className="border p-2 text-right">{displayQty(line.quantity_kg)} kg</td>
                <td className="border p-1">
                  <select aria-label={`Map GRV line ${line.line_index + 1} to chemical`}
                    value={grvMappings[line.line_index] || ""}
                    disabled={line.quantity_kg == null || line.quantity_kg <= 0}
                    onChange={(event) => setGrvMappings((current) => ({
                      ...current, [line.line_index]: event.target.value,
                    }))}
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 disabled:bg-slate-50"
                    data-testid={`monthly-sheet-grv-line-${line.line_index}-chemical`}>
                    <option value="">Do not import</option>
                    {MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </td>
              </tr>)}</tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">Map each GRV line to its chemical, then select “Add GRV”. Imported kg and each chemical’s total arrivals update immediately; save the sheet to keep the change. Do not enter GRV-imported quantities again as manual arrivals.</p>
          </div>}
          {sheet.arrival_sources.length > 0 && <div className="space-y-2" data-testid="monthly-sheet-imported-grvs">
            {sheet.arrival_sources.map((source) => <div key={source.grv_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm">
              <span><strong>{source.grv_number}</strong> · {source.received_date} · {source.supplier_name}
                <span className="ml-2 text-slate-500">{source.lines.map((line) =>
                  `${MONTHLY_SHEET_CHEMICALS.find(({ key }) => key === line.chemical_key)?.label || line.chemical_key}: ${displayQty(line.quantity_kg)} kg`).join(" · ")}</span>
              </span>
              <button type="button" aria-label={`Remove ${source.grv_number} from monthly sheet`}
                disabled={!canEdit || loading || !!loadError}
                onClick={() => removeArrivalSource(source.grv_id)}
                className="rounded p-1 text-red-700 hover:bg-red-50 disabled:opacity-50"
                data-testid={`monthly-sheet-remove-grv-${source.grv_id}`}>
                <Trash2 size={16} />
              </button>
            </div>)}
          </div>}
        </div>
      </Card>

      <Card className="overflow-hidden" data-testid="monthly-sheet-container-tracking">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">
          Chemical container tracking estimate
        </h2>
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Estimates use GRVs added to this month, verified kg-per-block formulas and weekly production. They do not measure actual drum levels, and exclude opening stock and manual arrivals without container details. Weekly consumption is assigned at week end because daily production dates are not recorded here.
        </p>
        {totals.containerTracking.every(({ containers }) => !containers.length) ? (
          <p className="p-4 text-sm text-slate-500">
            Add a chemical GRV with container capacity in kg to estimate container usage.
          </p>
        ) : <div className="space-y-4 p-4">
          {totals.containerTracking.filter(({ containers }) => containers.length > 0).map((tracking) => (
            <section key={tracking.chemical_key} data-testid={`monthly-container-chemical-${tracking.chemical_key}`}>
              <h3 className="mb-2 text-sm font-semibold text-slate-800">{tracking.chemical_label}</h3>
              {tracking.missing_rates.length > 0 && <p className="mb-2 text-xs text-amber-800" role="status">
                Add verified formula rates for {tracking.missing_rates.join(", ")} to estimate container depletion.
              </p>}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-xs">
                  <thead><tr>{[
                    "GRV / received", "Container", "Capacity each", "Containers received",
                    "Total received (kg)", "Estimated used (kg)", "Estimated remaining (kg)",
                    "Empty containers", "Depletion estimate",
                  ].map((heading) => <th key={heading} className="border bg-[#f7ead1] p-2 text-left">{heading}</th>)}</tr></thead>
                  <tbody>{tracking.containers.map((container) => {
                    const depletion = tracking.missing_rates.length
                      ? "Formula needed"
                      : container.depletion_week
                        ? `Week ${container.depletion_week}`
                        : container.status === "empty" ? "Emptied this month"
                          : "Not emptied this month";
                    return <tr key={`${container.grv_number}-${container.line_index}`}>
                      <td className="border p-2">{container.grv_number}<br /><span className="text-slate-500">{container.received_date}</span></td>
                      <td className="border p-2">{container.container_type || "Container"}</td>
                      <td className="border p-2 text-right">{displayQty(container.container_capacity)} {container.unit}</td>
                      <td className="border p-2 text-right">{displayQty(container.container_count)}</td>
                      <td className="border p-2 text-right">{displayQty(container.total_quantity_kg)}</td>
                      <td className="border p-2 text-right">{tracking.missing_rates.length ? "—" : displayQty(container.estimated_used_kg)}</td>
                      <td className="border p-2 text-right font-semibold">{tracking.missing_rates.length ? "—" : displayQty(container.remaining_quantity_kg)}</td>
                      <td className="border p-2 text-right">{tracking.missing_rates.length ? "—" : displayQty(container.empty_container_count)}</td>
                      <td className="border p-2">{depletion}</td>
                    </tr>;
                  })}</tbody>
                  {!tracking.missing_rates.length && <tfoot><tr className="bg-slate-50 font-semibold">
                    <td className="border p-2" colSpan="4">Tracked GRV containers total</td>
                    <td className="border p-2 text-right">{displayQty(tracking.tracked_quantity_kg)}</td>
                    <td className="border p-2 text-right">{displayQty(tracking.tracked_quantity_kg - tracking.tracked_remaining_kg)}</td>
                    <td className="border p-2 text-right">{displayQty(tracking.tracked_remaining_kg)}</td>
                    <td className="border p-2" colSpan="2">
                      {tracking.untracked_consumption_kg > 0
                        ? `${displayQty(tracking.untracked_consumption_kg)} kg consumption not matched to listed GRV containers`
                        : "All estimated consumption matched to listed GRV containers"}
                    </td>
                  </tr></tfoot>}
                </table>
              </div>
            </section>
          ))}
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">2. Weekly production (block count and weight in kg)</h2>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[1150px] border-collapse text-xs">
            <thead><tr>
              <th rowSpan="2" className="border bg-[#f7ead1] p-2">Week</th>
              {MONTHLY_SHEET_BLOCKS.map(({ key, label }) => <th key={key} colSpan="2" className="border bg-[#f7ead1] p-2">{label}</th>)}
              <th rowSpan="2" className="border bg-[#f7ead1] p-2">Total blocks</th>
              <th rowSpan="2" className="border bg-[#f7ead1] p-2">Total weight (kg)</th>
            </tr><tr>
              {MONTHLY_SHEET_BLOCKS.map(({ key }) => <th key={`${key}-units`} className="border p-2">Qty (pcs)</th>)
                .flatMap((quantityHeader, index) => [quantityHeader,
                  <th key={`${MONTHLY_SHEET_BLOCKS[index].key}-weight`} className="border p-2">Weight (kg)</th>])}
            </tr></thead>
            <tbody>
              {sheet.weeks.map((week, weekIndex) => {
                const weekBlocks = MONTHLY_SHEET_BLOCKS.reduce((total, { key }) => ({
                  quantity: total.quantity + (Number(week[key].quantity) || 0),
                  weight: total.weight + (Number(week[key].weight_kg) || 0),
                }), { quantity: 0, weight: 0 });
                return <tr key={weekIndex}>
                  <th className="border bg-slate-50 p-2 text-left">Week {weekIndex + 1}</th>
                  {MONTHLY_SHEET_BLOCKS.flatMap(({ key, label }) => [
                    <td key={`${key}-qty`} className="border p-1">
                      <NumberCell label={`Week ${weekIndex + 1} ${label} quantity`} value={week[key].quantity}
                        step="1" disabled={!canEdit || loading || !!loadError}
                        onChange={(value) => updateProduction(weekIndex, key, "quantity", value)}
                        testId={`monthly-week-${weekIndex + 1}-${key}-quantity`} />
                    </td>,
                    <td key={`${key}-weight`} className="border p-1">
                      <NumberCell label={`Week ${weekIndex + 1} ${label} weight in kg`} value={week[key].weight_kg}
                        disabled={!canEdit || loading || !!loadError}
                        onChange={(value) => updateProduction(weekIndex, key, "weight_kg", value)}
                        testId={`monthly-week-${weekIndex + 1}-${key}-weight`} />
                    </td>,
                  ])}
                  <td className="border bg-slate-50 p-2 text-right font-semibold">{displayQty(weekBlocks.quantity)}</td>
                  <td className="border bg-slate-50 p-2 text-right font-semibold">{displayQty(weekBlocks.weight)}</td>
                </tr>;
              })}
              <tr className="bg-[#f8ecd5] font-bold">
                <th className="border p-2 text-left">MONTH TOTAL</th>
                {MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
                  <td key={`${key}-qty-total`} className="border p-2 text-right">{displayQty(totals.blockTotals[key].quantity)}</td>,
                  <td key={`${key}-weight-total`} className="border p-2 text-right">{displayQty(totals.blockTotals[key].weight_kg)}</td>,
                ])}
                <td className="border p-2 text-right">{displayQty(totals.totalBlocks)}</td>
                <td className="border p-2 text-right">{displayQty(totals.totalBlockWeight)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">3. SuperIQFoam chemical formula (kg per block)</div>
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          Set the verified SuperIQFoam recipe rates below. No Manufacturing recipe is copied here. If a block was produced but a rate is blank, its consumption and final balance remain uncalculated.
        </div>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[1000px] border-collapse text-xs">
            <thead><tr>
              <th className="border bg-[#f7ead1] p-2 text-left">Production formula</th>
              {MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => <th key={key} className="border bg-[#f7ead1] p-2">{label}<br />kg / block</th>)}
            </tr></thead>
            <tbody>{MONTHLY_SHEET_BLOCKS.map(({ key, label }) => <tr key={key}>
              <th className="border bg-slate-50 p-2 text-left">{label}</th>
              {MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey, label: chemicalLabel }) => <td key={chemicalKey} className="border p-1">
                <NumberCell label={`${label}: ${chemicalLabel} kg per block`} value={sheet.formula_rates[key][chemicalKey]}
                  disabled={!canEdit || loading || !!loadError}
                  onChange={(value) => updateRate(key, chemicalKey, value)}
                  testId={`monthly-rate-${key}-${chemicalKey}`} />
              </td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">4. Chemical balance at month end</h2>
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          This worksheet balance is separate from Chemical Inventory and Chemical Usage records; it does not change inventory quantities.
        </p>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[850px] border-collapse text-sm">
            <thead><tr>
              {["Chemical", "Arrivals (kg)", "Consumption (kg)", "Final remaining (kg)", "Reorder below (kg)", "Status"].map((label) => <th key={label} className="border bg-[#f7ead1] p-2 text-left">{label}</th>)}
            </tr></thead>
            <tbody>
              {MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => {
                const balance = totals.chemicalBalances[key];
                const status = balance.status === "ok"
                  ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-700"><Check size={15} /> STOCK OK</span>
                  : balance.status === "reorder" ? <span className="font-bold text-red-700">REORDER</span>
                    : balance.status === "missing-formula" ? <span className="text-amber-800">Formula needed: {balance.missingRates.join(", ")}</span>
                      : balance.status === "missing-arrival" ? <span className="text-amber-800">Enter arrivals</span>
                        : <span className="text-slate-500">Set minimum</span>;
                return <tr key={key}>
                  <th className="border p-2 text-left">{label}</th>
                  <td className="border p-2 text-right">{displayQty(balance.arrival)}</td>
                  <td className="border p-2 text-right">{displayQty(balance.consumption)}</td>
                  <td className={`border p-2 text-right font-semibold ${balance.remaining != null && balance.remaining < 0 ? "text-red-700" : ""}`}>{displayQty(balance.remaining)}</td>
                  <td className="border p-1"><NumberCell label={`${label} reorder threshold in kg`} value={sheet.minimums[key]}
                    disabled={!canEdit || loading || !!loadError}
                    onChange={(value) => updateMinimum(key, value)}
                    testId={`monthly-minimum-${key}`} /></td>
                  <td className="border p-2">{status}</td>
                </tr>;
              })}
              <tr className="bg-[#f8ecd5] font-bold">
                <th className="border p-2 text-left">TOTAL</th>
                <td className="border p-2 text-right">{displayQty(totals.totalArrivals)}</td>
                <td className="border p-2 text-right">{displayQty(MONTHLY_SHEET_CHEMICALS.every(({ key }) => totals.chemicalBalances[key].consumption != null)
                  ? MONTHLY_SHEET_CHEMICALS.reduce((sum, { key }) => sum + totals.chemicalBalances[key].consumption, 0)
                  : null)}</td>
                <td className="border p-2 text-right">{displayQty(MONTHLY_SHEET_CHEMICALS.every(({ key }) => totals.chemicalBalances[key].remaining != null)
                  ? MONTHLY_SHEET_CHEMICALS.reduce((sum, { key }) => sum + totals.chemicalBalances[key].remaining, 0)
                  : null)}</td>
                <td className="border p-2" colSpan="2">Totals exclude incomplete formula rows</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
