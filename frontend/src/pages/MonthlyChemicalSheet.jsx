import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Download, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Btn, Card, Input, PageHeader, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import {
  downloadDailyChemicalAndBlockPdf,
  downloadMonthlyChemicalSheetPdf,
} from "@/lib/monthlyChemicalSheetPdf.mjs";
import {
  calculateMonthlySheet,
  calculateDailyProductionReport,
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
    production_days: blank.production_days.map((day) => {
      const savedDay = (saved?.production_days || []).find((item) => item.date === day.date);
      return {
        ...day,
        ...Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
          key,
          {
            quantity: cellValue(savedDay?.[key]?.quantity),
            weight_kg: cellValue(savedDay?.[key]?.weight_kg),
          },
        ])),
      };
    }),
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
  const isManufacturing = companyId === "iqfoam-manufactoring";
  const apiPath = isManufacturing
    ? "/warehouses/production-chemical-balance"
    : "/production/monthly-chemical-sheet";
  const companyLabel = isManufacturing ? "IQFOAM Manufacturing" : "SuperIQFoam";
  const canEdit = !user?.is_worker && (isManufacturing
    ? user?.is_owner || user?.is_company_owner || user?.role === "owner"
    : user?.is_primary_owner && user?.is_owner);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [dailyReportDate, setDailyReportDate] = useState(today());
  const [sheet, setSheet] = useState(() => createBlankMonthlySheet(today().slice(0, 7)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloadingDailyReport, setDownloadingDailyReport] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [section, setSection] = useState("production");
  const [selectedProductionWeek, setSelectedProductionWeek] = useState(0);
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
    api.getUncached(apiPath, { month })
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
  }, [month, apiPath]);

  useEffect(() => {
    let active = true;
    setGrvLoading(true);
    setGrvError("");
    setSelectedGrvId("");
    api.getUncached(`${apiPath}/grvs`, { month })
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
  }, [month, grvReload, apiPath]);

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
  const dailyReport = useMemo(
    () => calculateDailyProductionReport(sheet, dailyReportDate),
    [sheet, dailyReportDate],
  );
  const weekIndex = Math.min(selectedProductionWeek, sheet.weeks.length - 1);
  const selectedWeekDays = sheet.production_days.filter((day) => day.week_index === weekIndex);
  const selectedLegacyWeek = sheet.weeks[weekIndex];
  const selectedWeekHasDailyEntries = selectedWeekDays.some((day) =>
    MONTHLY_SHEET_BLOCKS.some(({ key }) =>
      day[key].quantity !== "" || day[key].weight_kg !== ""));
  const selectedWeekHasLegacyTotals = MONTHLY_SHEET_BLOCKS.some(({ key }) =>
    selectedLegacyWeek[key].quantity !== "" || selectedLegacyWeek[key].weight_kg !== "");
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
  const updateDailyProduction = (date, blockKey, field, value) => updateSheet({
    production_days: sheet.production_days.map((day) => day.date !== date
      ? day
      : { ...day, [blockKey]: { ...day[blockKey], [field]: value } }),
  });

  useEffect(() => {
    setDailyReportDate(month === today().slice(0, 7) ? today() : `${month}-01`);
  }, [month]);

  const save = async () => {
    if (!canEdit) {
      toast.error(isManufacturing
        ? "Only a company owner can save IQFOAM Manufacturing data."
        : "Only the primary owner can save SuperIQFOAM company data.");
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put(apiPath, monthlySheetPayload(sheet));
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
      const saved = await api.put(apiPath, monthlySheetPayload(resetSheet));
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

  const exportDailyReportPdf = async () => {
    if (!dailyReport || downloadingDailyReport) return;
    setDownloadingDailyReport(true);
    try {
      await downloadDailyChemicalAndBlockPdf(dailyReport);
    } catch (error) {
      toast.error(`Could not create daily chemical and block PDF: ${apiError(error)}`);
    } finally {
      setDownloadingDailyReport(false);
    }
  };

  if (!["superiqfoam", "iqfoam-manufactoring"].includes(companyId)) {
    return <Card className="p-6"><p className="font-semibold text-red-700">This sheet is only available in the SUPERIQFOAM and IQFOAM Manufacturing profiles.</p></Card>;
  }

  return (
    <div className="space-y-5" data-testid="monthly-chemical-sheet">
      <PageHeader
        title="Production Management & Chemical Balance"
        subtitle="Enter monthly chemical arrivals and daily production. Switch between the calendar weeks in the selected month."
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
        This sheet is read-only for this account. {isManufacturing ? "A company owner" : "The primary owner"} can enter and save data.
      </Card>}

      <div className="flex gap-2 border-b border-border">
        <button type="button" aria-pressed={section === "production"}
          onClick={() => setSection("production")}
          className={`border-b-2 px-3 py-2 text-sm font-semibold ${section === "production" ? "border-primary text-primary" : "border-transparent text-slate-500"}`}
          data-testid="monthly-sheet-production-tab">
          Production
        </button>
        <button type="button" aria-pressed={section === "details"}
          onClick={() => setSection("details")}
          className={`border-b-2 px-3 py-2 text-sm font-semibold ${section === "details" ? "border-primary text-primary" : "border-transparent text-slate-500"}`}
          data-testid="monthly-sheet-details-tab">
          Details
        </button>
        {isManufacturing && <button type="button" aria-pressed={section === "daily-report"}
          onClick={() => setSection("daily-report")}
          className={`border-b-2 px-3 py-2 text-sm font-semibold ${section === "daily-report" ? "border-primary text-primary" : "border-transparent text-slate-500"}`}
          data-testid="monthly-sheet-daily-report-tab">
          Daily Report
        </button>}
      </div>

      <Card className="overflow-hidden" hidden={section !== "production"}>
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

      <Card className="overflow-hidden" hidden={section !== "details"} data-testid="monthly-sheet-container-tracking">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">
          Chemical and container balance
        </h2>
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Direct calculation: blocks made × formula (kg per block) = chemical used. That use is deducted from this month’s GRV containers, oldest receipt first. “Containers remaining” is calculated, not a physical drum check. Opening stock and manual arrivals without container details are not included.
        </p>
        {totals.containerTracking.every(({ containers }) => !containers.length) ? (
          <p className="p-4 text-sm text-slate-500">
            Add a chemical GRV with container capacity in kg to calculate container balances.
          </p>
        ) : <div className="space-y-4 p-4">
          {totals.containerTracking.filter(({ containers }) => containers.length > 0).map((tracking) => (
            <section key={tracking.chemical_key} data-testid={`monthly-container-chemical-${tracking.chemical_key}`}>
              <h3 className="mb-2 text-sm font-semibold text-slate-800">{tracking.chemical_label}</h3>
              {tracking.missing_rates.length > 0 && <p className="mb-2 text-xs text-amber-800" role="status">
                Add verified formula rates for {tracking.missing_rates.join(", ")} to calculate use and containers remaining.
              </p>}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1600px] border-collapse text-xs">
                  <thead><tr>{[
                    "GRV / date", "Container type", "Size each", "Received",
                    ...MONTHLY_SHEET_BLOCKS.map(({ label }) => `${label} used (kg)`),
                    "GRV total (kg)", "Used (kg)", "Chemical left (kg)",
                    "Containers left", "Empty", "Depletion",
                  ].map((heading) => <th key={heading} className="border bg-[#f7ead1] p-2 text-left">{heading}</th>)}</tr></thead>
                  <tbody>{tracking.containers.map((container) => {
                    const depletion = tracking.missing_rates.length
                      ? "Formula needed"
                      : container.status === "container-data-mismatch"
                        ? "Check GRV container details"
                      : container.depletion_week
                        ? `Week ${container.depletion_week}`
                        : container.status === "empty" ? "Emptied this month"
                          : "Not emptied this month";
                    return <tr key={`${container.grv_number}-${container.line_index}`}>
                      <td className="border p-2">{container.grv_number}<br /><span className="text-slate-500">{container.received_date}</span></td>
                      <td className="border p-2">{container.container_type || "Container"}</td>
                      <td className="border p-2 text-right">{displayQty(container.container_capacity)} {container.unit}</td>
                      <td className="border p-2 text-right">{displayQty(container.container_count)}</td>
                      {MONTHLY_SHEET_BLOCKS.map(({ key }) => <td key={key} className="border p-2 text-right">
                        {tracking.missing_rates.length ? "—" : displayQty(container.usage_by_block[key])}
                      </td>)}
                      <td className="border p-2 text-right">{displayQty(container.total_quantity_kg)}</td>
                      <td className="border p-2 text-right">{tracking.missing_rates.length ? "—" : displayQty(container.actually_used_kg)}</td>
                      <td className="border p-2 text-right font-semibold">{tracking.missing_rates.length ? "—" : displayQty(container.remaining_quantity_kg)}</td>
                      <td className="border p-2 text-right">{tracking.missing_rates.length || !container.container_data_consistent
                        ? "—" : displayQty(container.containers_with_stock)}</td>
                      <td className="border p-2 text-right">{tracking.missing_rates.length || !container.container_data_consistent
                        ? "—" : displayQty(container.empty_container_count)}</td>
                      <td className="border p-2">{depletion}</td>
                    </tr>;
                  })}</tbody>
                  {!tracking.missing_rates.length && <tfoot><tr className="bg-slate-50 font-semibold">
                    <td className="border p-2" colSpan={4 + MONTHLY_SHEET_BLOCKS.length}>Tracked GRV containers total</td>
                    <td className="border p-2 text-right">{displayQty(tracking.tracked_quantity_kg)}</td>
                    <td className="border p-2 text-right">{displayQty(tracking.containers.reduce((sum, container) => sum + container.actually_used_kg, 0))}</td>
                    <td className="border p-2 text-right">{displayQty(tracking.tracked_remaining_kg)}</td>
                    <td className="border p-2 text-right">{tracking.containers.some((container) => !container.container_data_consistent)
                      ? "—" : displayQty(tracking.containers.reduce((sum, container) =>
                        sum + (container.containers_with_stock || 0), 0))}</td>
                    <td className="border p-2 text-right">{tracking.containers.some((container) => !container.container_data_consistent)
                      ? "—" : displayQty(tracking.containers.reduce((sum, container) =>
                        sum + (container.empty_container_count || 0), 0))}</td>
                    <td className="border p-2">
                      {tracking.untracked_consumption_kg > 0
                        ? `${displayQty(tracking.untracked_consumption_kg)} kg use not matched to listed GRV containers`
                        : "All calculated use matched to listed GRV containers"}
                    </td>
                  </tr></tfoot>}
                </table>
              </div>
            </section>
          ))}
        </div>}
      </Card>

      <Card className="overflow-hidden" hidden={section !== "production"} data-testid="monthly-daily-production">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">
          2. Daily production (block count and weight in kg)
        </h2>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 pt-3" aria-label="Production week">
          {Array.from({ length: sheet.weeks.length }, (_, index) => {
            const days = sheet.production_days.filter((day) => day.week_index === index);
            const first = days[0]?.date;
            const last = days.at(-1)?.date;
            const range = first && last
              ? ` · ${Number(first.slice(-2))}-${Number(last.slice(-2))}`
              : "";
            return <button key={index} type="button" aria-pressed={weekIndex === index}
              onClick={() => setSelectedProductionWeek(index)}
              className={`rounded-t-md border-b-2 px-3 py-2 text-sm font-semibold ${weekIndex === index
                ? "border-primary text-primary" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              data-testid={`monthly-production-week-${index + 1}`}>
              Week {index + 1}{range}
            </button>;
          })}
        </div>
        {selectedWeekHasLegacyTotals && !selectedWeekHasDailyEntries && <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900" role="status">
          This week has saved weekly totals from the previous format. They remain included in monthly calculations until you enter daily production for this week. Once you start, enter the complete daily records for this week; the old weekly totals are retained but no longer added again.
        </p>}
        {selectedWeekHasLegacyTotals && selectedWeekHasDailyEntries && <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900" role="status">
          Daily entries are used for this week. The previous weekly totals are preserved in storage but are not added to avoid double counting.
        </p>}
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[1250px] border-collapse text-xs">
            <thead><tr>
              <th rowSpan="2" className="border bg-[#f7ead1] p-2 text-left">Production date</th>
              {MONTHLY_SHEET_BLOCKS.map(({ key, label }) => <th key={key} colSpan="2" className="border bg-[#f7ead1] p-2">{label}</th>)}
              <th rowSpan="2" className="border bg-[#f7ead1] p-2">Daily blocks</th>
              <th rowSpan="2" className="border bg-[#f7ead1] p-2">Daily weight (kg)</th>
            </tr><tr>
              {MONTHLY_SHEET_BLOCKS.map(({ key }) => <th key={`${key}-units`} className="border p-2">Qty (pcs)</th>)
                .flatMap((quantityHeader, index) => [quantityHeader,
                  <th key={`${MONTHLY_SHEET_BLOCKS[index].key}-weight`} className="border p-2">Weight (kg)</th>])}
            </tr></thead>
            <tbody>{selectedWeekDays.map((day) => {
              const dayTotals = MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) => ({
                quantity: sum.quantity + (Number(day[key].quantity) || 0),
                weight: sum.weight + (Number(day[key].weight_kg) || 0),
              }), { quantity: 0, weight: 0 });
              const date = new Date(`${day.date}T00:00:00Z`);
              const dateLabel = date.toLocaleDateString("en-GB", {
                weekday: "short", day: "2-digit", month: "short", timeZone: "UTC",
              });
              return <tr key={day.date} data-testid={`monthly-production-day-${day.date}`}>
                <th className="border bg-slate-50 p-2 text-left">{dateLabel}</th>
                {MONTHLY_SHEET_BLOCKS.flatMap(({ key, label }) => [
                  <td key={`${key}-qty`} className="border p-1">
                    <NumberCell label={`${dateLabel} ${label} quantity`} value={day[key].quantity}
                      step="1" disabled={!canEdit || loading || !!loadError}
                      onChange={(value) => updateDailyProduction(day.date, key, "quantity", value)}
                      testId={`monthly-day-${day.date}-${key}-quantity`} />
                  </td>,
                  <td key={`${key}-weight`} className="border p-1">
                    <NumberCell label={`${dateLabel} ${label} weight in kg`} value={day[key].weight_kg}
                      disabled={!canEdit || loading || !!loadError}
                      onChange={(value) => updateDailyProduction(day.date, key, "weight_kg", value)}
                      testId={`monthly-day-${day.date}-${key}-weight`} />
                  </td>,
                ])}
                <td className="border bg-slate-50 p-2 text-right font-semibold">{displayQty(dayTotals.quantity)}</td>
                <td className="border bg-slate-50 p-2 text-right font-semibold">{displayQty(dayTotals.weight)}</td>
              </tr>;
            })}</tbody>
            <tfoot>
              <tr className="bg-[#f8ecd5] font-bold">
                <th className="border p-2 text-left">WEEK {weekIndex + 1} TOTAL</th>
                {MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
                  <td key={`${key}-qty-week`} className="border p-2 text-right">{displayQty(totals.productionByWeek[weekIndex][key].quantity)}</td>,
                  <td key={`${key}-weight-week`} className="border p-2 text-right">{displayQty(totals.productionByWeek[weekIndex][key].weight_kg)}</td>,
                ])}
                <td className="border p-2 text-right">{displayQty(MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) =>
                  sum + totals.productionByWeek[weekIndex][key].quantity, 0))}</td>
                <td className="border p-2 text-right">{displayQty(MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) =>
                  sum + totals.productionByWeek[weekIndex][key].weight_kg, 0))}</td>
              </tr>
              <tr className="bg-slate-100 font-bold">
                <th className="border p-2 text-left">MONTH TOTAL</th>
                {MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
                  <td key={`${key}-qty-month`} className="border p-2 text-right">{displayQty(totals.blockTotals[key].quantity)}</td>,
                  <td key={`${key}-weight-month`} className="border p-2 text-right">{displayQty(totals.blockTotals[key].weight_kg)}</td>,
                ])}
                <td className="border p-2 text-right">{displayQty(totals.totalBlocks)}</td>
                <td className="border p-2 text-right">{displayQty(totals.totalBlockWeight)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden" hidden={section !== "production"}>
        <div className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">3. {companyLabel} chemical formula (kg per block)</div>
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          Set the verified {companyLabel} recipe rates below. If a block was produced but a rate is blank, its consumption and final balance remain uncalculated.
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

      <Card className="overflow-hidden" hidden={section !== "details"}>
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">4. Chemical balance at month end</h2>
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          This worksheet balance is separate from inventory stock records; it does not change physical stock quantities.
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
                  : balance.status === "finished" ? <span className="font-bold text-red-800">FINISHED</span>
                    : balance.status === "reorder" ? <span className="font-bold text-red-700">RE-ORDER AS SOON AS POSSIBLE</span>
                    : balance.status === "missing-formula" ? <span className="text-amber-800">Formula needed: {balance.missingRates.join(", ")}</span>
                      : balance.status === "missing-arrival" ? <span className="text-amber-800">Enter arrivals</span>
                        : <span className="text-slate-500">Set minimum</span>;
                return <tr key={key}>
                  <th className="border p-2 text-left">{label}</th>
                  <td className="border p-2 text-right">{displayQty(balance.arrival)}</td>
                  <td className="border p-2 text-right">{displayQty(balance.consumption)}</td>
                  <td className={`border p-2 text-right font-semibold ${balance.remaining != null && balance.remaining <= 0 ? "text-red-700" : ""}`}>{displayQty(balance.remaining)}</td>
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

      {isManufacturing && <Card className="overflow-hidden" hidden={section !== "daily-report"} data-testid="manufacturing-daily-production-report">
        <h2 className="bg-[#171812] px-4 py-3 text-sm font-bold uppercase text-white">
          Daily Production & Chemical Balance Report
        </h2>
        <div className="space-y-3 border-b border-slate-200 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Input
              label="Report date"
              type="date"
              min={`${month}-01`}
              max={`${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, "0")}`}
              value={dailyReportDate}
              onChange={(event) => setDailyReportDate(event.target.value)}
              disabled={loading || !!loadError}
              data-testid="manufacturing-daily-report-date"
            />
            <Btn
              variant="outline"
              onClick={exportDailyReportPdf}
              disabled={!dailyReport || downloadingDailyReport || loading || !!loadError}
              data-testid="manufacturing-daily-report-pdf"
            >
              <Download size={16} />
              {downloadingDailyReport ? "Creating PDF..." : "Download Daily Chemical and Block PDF"}
            </Btn>
          </div>
          <p className="text-xs text-slate-600">
            Usage is calculated from this date’s block quantities and saved formula rates. Remaining chemical includes this month’s manual arrivals and confirmed GRVs received by this date; opening stock and weekly totals without daily dates are not included. Barrel counts and tracked kg use dated GRV container details only and are estimates, not physical stock counts.
          </p>
          {dailyReport?.undatedArrivalCount > 0 && <p className="text-xs text-amber-800" role="status">
            {dailyReport.undatedArrivalCount} saved GRV receipt(s) have no receipt date and are excluded from this dated report.
          </p>}
        </div>
        {!dailyReport ? (
          <p className="p-4 text-sm text-slate-500">Choose a valid date in the selected month to view its report.</p>
        ) : <>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Total blocks made</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-slate-800" data-testid="manufacturing-daily-report-total-blocks">
                {displayQty(dailyReport.totalBlocks)}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Total block weight</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-slate-800" data-testid="manufacturing-daily-report-total-weight">
                {displayQty(dailyReport.totalWeightKg)} kg
              </p>
            </div>
          </div>
          <div className="space-y-5 p-4 pt-0">
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-800">Blocks made by type</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] border-collapse text-sm">
                  <thead><tr>
                    <th className="border bg-[#f7ead1] p-2 text-left">Block type</th>
                    <th className="border bg-[#f7ead1] p-2 text-right">Blocks made</th>
                    <th className="border bg-[#f7ead1] p-2 text-right">Weight (kg)</th>
                  </tr></thead>
                  <tbody>{dailyReport.blocks.map((block) => <tr key={block.key}>
                    <th className="border p-2 text-left">{block.label}</th>
                    <td className="border p-2 text-right tabular-nums">{displayQty(block.quantity)}</td>
                    <td className="border p-2 text-right tabular-nums">{displayQty(block.weight_kg)}</td>
                  </tr>)}</tbody>
                  <tfoot><tr className="bg-[#f8ecd5] font-bold">
                    <th className="border p-2 text-left">DAILY TOTAL</th>
                    <td className="border p-2 text-right tabular-nums">{displayQty(dailyReport.totalBlocks)}</td>
                    <td className="border p-2 text-right tabular-nums">{displayQty(dailyReport.totalWeightKg)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-800">Chemical used today and remaining balance</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1250px] border-collapse text-xs">
                  <thead><tr>
                    <th className="border bg-[#f7ead1] p-2 text-left">Chemical</th>
                    {MONTHLY_SHEET_BLOCKS.map(({ key, label }) => <th key={key} className="border bg-[#f7ead1] p-2 text-right">{label} used (kg)</th>)}
                    <th className="border bg-[#f7ead1] p-2 text-right">Used today (kg)</th>
                    <th className="border bg-[#f7ead1] p-2 text-right">Chemical remaining (kg)</th>
                    <th className="border bg-[#f7ead1] p-2 text-right">Barrels / containers with stock</th>
                    <th className="border bg-[#f7ead1] p-2 text-right">GRV-tracked kg remaining</th>
                  </tr></thead>
                  <tbody>{dailyReport.chemicalUsage.map((usage) => {
                    const balance = dailyReport.balances.find(({ key }) => key === usage.key);
                    return <tr key={usage.key} data-testid={`manufacturing-daily-report-chemical-${usage.key}`}>
                      <th className="border p-2 text-left">{usage.label}</th>
                      {usage.byBlock.map((block) => <td key={block.block_key} className="border p-2 text-right tabular-nums">
                        {displayQty(block.used_kg)}
                      </td>)}
                      <td className="border p-2 text-right font-semibold tabular-nums">{displayQty(usage.used_today_kg)}</td>
                      <td className="border p-2 text-right font-semibold tabular-nums">{displayQty(balance.remaining_kg)}</td>
                      <td className="border p-2 text-right tabular-nums">{displayQty(balance.barrels_remaining)}</td>
                      <td className="border p-2 text-right tabular-nums">{displayQty(balance.tracked_remaining_kg)}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              {dailyReport.chemicalUsage.some(({ missingRates }) => missingRates.length > 0) && <p className="mt-2 text-xs text-amber-800" role="status">
                Complete verified formula rates for the produced block types to calculate chemical use and the remaining balance.
              </p>}
              {dailyReport.balances.some(({ hasContainerMismatch }) => hasContainerMismatch) && <p className="mt-2 text-xs text-amber-800" role="status">
                Barrel counts are not shown for GRV lines where accepted kg do not match container capacity × quantity. Review those GRV details.
              </p>}
            </section>
          </div>
        </>}
      </Card>}
    </div>
  );
}
