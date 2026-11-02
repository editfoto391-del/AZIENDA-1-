import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { Btn, Card, Empty, Input, PageHeader } from "@/components/common";
import { useAuth } from "@/context/AuthContext";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";

const blankLine = () => ({ chemical: "", unit: "kg", used_quantity: "", initial_quantity: "", remaining_estimate: "" });
const fmtQty = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function ChemicalStock() {
  const { user } = useAuth();
  const canDelete = !user?.is_worker && (user?.is_owner || user?.is_company_owner);
  const [logs, setLogs] = useState(null);
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([blankLine()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => api.getUncached("/warehouses/chemical/logs")
    .then(setLogs)
    .catch((error) => { toast.error(apiError(error)); setLogs([]); });
  useEffect(() => { load(); }, []);

  // Latest estimate per chemical, from the most recent dated entry.
  const latest = useMemo(() => {
    const byChemical = new Map();
    [...(logs || [])]
      .sort((a, b) => (a.date === b.date ? String(a.created_at || "").localeCompare(String(b.created_at || "")) : a.date.localeCompare(b.date)))
      .forEach((log) => log.lines.forEach((line) => {
        byChemical.set(line.chemical.toLowerCase(), { ...line, date: log.date });
      }));
    return [...byChemical.values()].sort((a, b) => a.chemical.localeCompare(b.chemical));
  }, [logs]);

  const latestByName = useMemo(() => new Map(latest.map((item) => [item.chemical.toLowerCase(), item])), [latest]);

  // Remaining is calculated from the initial quantity (or the last known estimate) minus today's usage, unless typed manually.
  const calcRemaining = (line) => {
    if (line.remainingManual) return line.remaining_estimate;
    const base = line.initial_quantity !== "" ? Number(line.initial_quantity) : latestByName.get(line.chemical.trim().toLowerCase())?.remaining_estimate;
    if (base == null || !Number.isFinite(base)) return "";
    const result = base - (line.used_quantity === "" ? 0 : Number(line.used_quantity));
    return Number.isFinite(result) ? String(Math.round(result * 10000) / 10000) : "";
  };

  const setLine = (index, patch) => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));

  const prefill = (item) => setLines((current) => {
    const rest = current.filter((line) => line.chemical.trim());
    if (rest.some((line) => line.chemical.toLowerCase() === item.chemical.toLowerCase())) return current;
    return [...rest, { ...blankLine(), chemical: item.chemical, unit: item.unit }];
  });

  const save = async () => {
    const withRemaining = lines.map((line) => ({ ...line, remaining_estimate: calcRemaining(line) }));
    const filled = withRemaining.filter((line) => line.chemical.trim() || line.remaining_estimate !== "" || line.used_quantity !== "" || line.initial_quantity !== "");
    if (!filled.length) return toast.error("Add at least one chemical");
    for (const line of filled) {
      if (!line.chemical.trim()) return toast.error("Every row needs a chemical name");
      const remaining = Number(line.remaining_estimate);
      const initial = Number(line.initial_quantity);
      const used = line.used_quantity === "" ? 0 : Number(line.used_quantity);
      if (line.remaining_estimate === "") {
        return toast.error(`Enter the initial quantity or the remaining quantity for ${line.chemical}`);
      }
      if (!Number.isFinite(remaining) || remaining < 0) {
        return toast.error(`Remaining quantity for ${line.chemical} cannot be negative - check the used quantity`);
      }
      if (line.initial_quantity !== "" && (!Number.isFinite(initial) || initial < 0)) {
        return toast.error(`Enter a valid initial quantity for ${line.chemical}`);
      }
      if (!Number.isFinite(used) || used < 0) return toast.error(`Enter a valid used quantity for ${line.chemical}`);
    }
    setSaving(true);
    try {
      await api.post("/warehouses/chemical/logs", {
        date,
        notes,
        lines: filled.map((line) => ({
          chemical: line.chemical.trim(),
          unit: line.unit.trim() || "kg",
          used_quantity: line.used_quantity === "" ? 0 : Number(line.used_quantity),
          initial_quantity: line.initial_quantity === "" ? null : Number(line.initial_quantity),
          remaining_estimate: Number(line.remaining_estimate),
        })),
      });
      toast.success("Chemical estimate saved");
      setLines([blankLine()]);
      setNotes("");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (log) => {
    if (!window.confirm(`Delete the chemical entry of ${log.date}? This cannot be undone.`)) return;
    try {
      await api.del(`/warehouses/chemical/logs/${log.id}`);
      toast.success("Entry deleted");
      await load();
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  return (
    <div data-testid="chemical-page">
      <PageHeader title="Chemical" subtitle="Daily production update: chemical used and estimated quantity remaining. Enter the initial quantity when new stock arrives and the used quantity: the remaining is calculated automatically (you can also type it manually)." />

      <Card className="p-5 mb-6">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3"><FlaskConical size={16} /> Current estimated chemical stock</h2>
        {logs === null ? <p className="text-slate-400 text-sm">Loading...</p> : latest.length === 0 ? <Empty>No chemical estimates recorded yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b"><th className="py-2">Chemical</th><th>Estimated remaining</th><th>Last updated</th><th /></tr></thead>
              <tbody>{latest.map((item) => (
                <tr key={item.chemical} className="border-b last:border-0">
                  <td className="py-2 font-semibold text-slate-800">{item.chemical}</td>
                  <td>{fmtQty(item.remaining_estimate)} {item.unit}</td>
                  <td className="text-slate-500">{item.date}</td>
                  <td className="text-right"><Btn variant="outline" onClick={() => prefill(item)}>Update</Btn></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">Daily update</h2>
        <div className="max-w-xs mb-4"><Input label="Production date" type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value)} data-testid="chemical-date" /></div>
        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className="grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-3 items-end">
              <div className="col-span-2 md:col-span-1"><Input label="Chemical" value={line.chemical} onChange={(event) => setLine(index, { chemical: event.target.value })} data-testid={`chemical-name-${index}`} /></div>
              <Input label="Unit" value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })} />
              <Input label="Initial quantity (optional)" type="number" min="0" step="any" value={line.initial_quantity} onChange={(event) => setLine(index, { initial_quantity: event.target.value })} data-testid={`chemical-initial-${index}`} />
              <Input label="Used today" type="number" min="0" step="any" value={line.used_quantity} onChange={(event) => setLine(index, { used_quantity: event.target.value })} />
              <Input label="Remaining (auto, editable)" type="number" min="0" step="any" value={calcRemaining(line)} onChange={(event) => setLine(index, { remaining_estimate: event.target.value, remainingManual: event.target.value !== "" })} data-testid={`chemical-remaining-${index}`} />
              <Btn variant="outline" onClick={() => setLines((current) => current.length > 1 ? current.filter((_, i) => i !== index) : [blankLine()])} aria-label="Remove row"><Trash2 size={15} /></Btn>
            </div>
          ))}
        </div>
        <div className="mt-3"><Btn variant="outline" onClick={() => setLines((current) => [...current, blankLine()])}><Plus size={15} /> Add chemical</Btn></div>
        <div className="mt-4"><Input label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
        <div className="mt-4 flex justify-end"><Btn disabled={saving} onClick={save} data-testid="chemical-save"><Save size={16} /> {saving ? "Saving..." : "Save daily update"}</Btn></div>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-yellow-600 mb-3">History</h2>
        {logs === null ? null : logs.length === 0 ? <Empty>No entries yet.</Empty> : (
          <div className="space-y-3">
            {logs.map((log) => (
              <div key={log.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="font-semibold text-slate-800">{log.date} <span className="text-xs font-normal text-slate-400">by {log.created_by_name || "—"}</span></div>
                  {canDelete && <Btn variant="outline" onClick={() => remove(log)}><Trash2 size={14} /> Delete</Btn>}
                </div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500"><th>Chemical</th><th>Initial</th><th>Used</th><th>Estimated remaining</th></tr></thead>
                  <tbody>{log.lines.map((line, index) => (
                    <tr key={index}><td>{line.chemical}</td><td>{line.initial_quantity != null ? `${fmtQty(line.initial_quantity)} ${line.unit}` : "—"}</td><td>{fmtQty(line.used_quantity)} {line.unit}</td><td>{fmtQty(line.remaining_estimate)} {line.unit}</td></tr>
                  ))}</tbody>
                </table>
                {log.notes && <p className="mt-2 text-xs text-slate-500">{log.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
