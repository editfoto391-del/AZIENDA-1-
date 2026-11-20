export function fmtMoney(n) {
  const v = Number(n || 0);
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-R " : "R ") + s;
}

export function documentFilename(...parts) {
  const safeParts = parts
    .filter(Boolean)
    .map((part) => String(part).normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, ""));
  return safeParts.filter(Boolean).join("-") || "document";
}

export const TZ = "Africa/Johannesburg";

export function fmtDateTime(s) {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString("en-ZA", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtDataUpdateDateTime(s) {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString("en-ZA", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function nowLocalInput() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

export function newKey() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
}

export function fmtDate(s) {
  if (!s) return "-";
  try {
    const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
    return d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return s;
  }
}

export function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
}

export const STATUS_META = {
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  issued: { label: "Issued", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  partially_paid: { label: "Partially Paid", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  overdue: { label: "Overdue", cls: "bg-red-50 text-red-700 border-red-200" },
  void: { label: "Void", cls: "bg-slate-100 text-slate-400 border-slate-200 line-through" },
};
