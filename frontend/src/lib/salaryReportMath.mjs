export const moneyToCents = (value) => {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value ?? "").trim());
  if (!match) return 0;
  const fraction = match[3] || "";
  let cents = BigInt(match[2]) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (fraction[2] >= "5") cents += 1n;
  return Number(match[1] === "-" ? -cents : cents);
};

export const isPieceworkTailor = (employee) => {
  const name = String(employee?.name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return name === "AYANDA TAILOR" || name === "ASIVE TAILOR";
};

export const sumPayrollRows = (rows) => rows.reduce((totals, row) => ({
  grossCents: totals.grossCents + row.grossCents,
  cutCents: totals.cutCents + row.cutCents,
  netCents: totals.netCents + row.netCents,
}), { grossCents: 0, cutCents: 0, netCents: 0 });
