export function updateGrvReceivedQuantity(line, value) {
  const previousReceived = Number(line.actual_received_quantity) || 0;
  const accepted = Number(line.accepted_quantity) || 0;
  const received = Number(value) || 0;

  return {
    ...line,
    actual_received_quantity: received,
    ...(accepted === previousReceived ? { accepted_quantity: received } : {}),
  };
}

export function parseGrvDecimal(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return 0;
  const normalized = text.includes(",") && text.includes(".")
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(",", ".");
  return Number(normalized);
}

export function grvTotals(items = [], vatRate = 0) {
  const subtotal = items.reduce((sum, line) => {
    const quantity = Number(line.accepted_quantity) || 0;
    const unitCost = parseGrvDecimal(line.unit_cost);
    return sum + quantity * (Number.isFinite(unitCost) ? unitCost : 0);
  }, 0);
  const rate = parseGrvDecimal(vatRate);
  const vatAmount = subtotal * (Number.isFinite(rate) ? rate : 0) / 100;
  return {
    subtotal,
    vatAmount,
    total: subtotal + vatAmount,
  };
}
