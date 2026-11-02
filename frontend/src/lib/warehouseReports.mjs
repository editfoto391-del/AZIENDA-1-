function quantityTotal(lines, field = "quantity") {
  return lines.reduce((total, line) => total + (Number(line?.[field]) || 0), 0);
}

function countValue(lines, field, singular, plural = `${singular}s`) {
  const total = quantityTotal(lines, field);
  return `${total.toLocaleString("en-ZA")} ${total === 1 ? singular : plural}`;
}

function groupedQuantitySummary(lines, getLabel) {
  const totals = new Map();
  for (const line of lines) {
    const quantity = Number(line?.quantity) || 0;
    const label = getLabel(line);
    if (!label || quantity <= 0) continue;
    totals.set(label, (totals.get(label) || 0) + quantity);
  }
  if (!totals.size) return "—";
  return [...totals.entries()]
    .map(([label, quantity]) => `${label}: ${quantity.toLocaleString("en-ZA")}`)
    .join(" · ");
}

export function warehouseReportTotalsForDate(date, draft, savedReports) {
  const savedReportsForDate = savedReports.filter((report) => report.date === date);
  return Object.fromEntries(
    Object.entries(draft)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, draftLines]) => [
        key,
        [
          ...savedReportsForDate.flatMap((report) => (
            Array.isArray(report[key]) ? report[key] : []
          )),
          ...draftLines,
        ],
      ]),
  );
}

export function warehouseReportDetails(warehouseId, report) {
  const sectionsByWarehouse = {
    A: [
      ["chemicals", "Chemical usage", [["chemical", "Chemical"], ["quantity", "Quantity"], ["unit", "Unit"]]],
      ["manufactured_blocks", "Manufactured blocks", [["block_type", "Block type"], ["size", "Size"], ["quantity", "Quantity"]]],
      ["foam_cut", "Foam cut", [["size", "Size"], ["quantity", "Quantity"], ["unit", "Unit"]]],
      ["damaged_blocks", "Damaged and broken blocks", [["block_type", "Block type"], ["size", "Size"], ["quantity", "Quantity"]]],
      ["sheets_cut", "Sheets cut", [["size", "Size"], ["quantity", "Quantity"]]],
    ],
    B: [
      ["foam_received", "Foam received", [["quantity", "Quantity"], ["unit", "Unit"]]],
      ["mattresses_received", "Mattresses received", [["size", "Size"], ["quantity", "Quantity"]]],
      ["mattresses_completed", "Mattresses completed and bundled", [["size", "Size"], ["quantity", "Bundles"]]],
    ],
    C: [
      ["completed_stock", "Completed stock added", [["size", "Size"], ["quantity", "Quantity"]]],
      ["dispatches", "Customer dispatches", [
        ["customer_name", "Customer"],
        ["invoice_number", "Invoice"],
        ["size", "Size"],
        ["ordered_quantity", "Ordered"],
        ["loaded_quantity", "Loaded"],
      ]],
    ],
  };
  return (sectionsByWarehouse[warehouseId] || [])
    .filter(([key]) => Array.isArray(report?.[key]) && report[key].length > 0)
    .map(([key, title, fields]) => ({ key, title, fields, rows: report[key] }));
}

export function warehouseReportMetrics(warehouseId, report) {
  const lines = (key) => Array.isArray(report?.[key]) ? report[key] : [];
  if (warehouseId === "A") {
    const chemicals = lines("chemicals");
    const manufactured = lines("manufactured_blocks");
    const foamCut = lines("foam_cut");
    const damaged = lines("damaged_blocks");
    const sheets = lines("sheets_cut");
    return [
      { label: "Total chemical usage", value: groupedQuantitySummary(chemicals, (line) => `${line.chemical} (${line.unit})`) },
      { label: "Total blocks manufactured", value: countValue(manufactured, "quantity", "block") },
      { label: "Manufactured by type and size", value: groupedQuantitySummary(manufactured, (line) => `${line.block_type} · ${line.size}`) },
      { label: "Total foam cut", value: groupedQuantitySummary(foamCut, (line) => `${line.size} ${line.unit}`) },
      { label: "Total damaged and broken blocks", value: countValue(damaged, "quantity", "block") },
      { label: "Damaged blocks by type and size", value: groupedQuantitySummary(damaged, (line) => `${line.block_type} · ${line.size}`) },
      { label: "Total sheets cut", value: countValue(sheets, "quantity", "sheet") },
      { label: "Sheets cut by size", value: groupedQuantitySummary(sheets, (line) => line.size) },
    ];
  }

  if (warehouseId === "B") {
    const foamReceived = lines("foam_received");
    const mattressesReceived = lines("mattresses_received");
    const mattressesCompleted = lines("mattresses_completed");
    return [
      { label: "Total foam received", value: groupedQuantitySummary(foamReceived, (line) => line.unit) },
      { label: "Total mattresses received", value: countValue(mattressesReceived, "quantity", "pc", "pcs") },
      { label: "Mattresses received by size", value: groupedQuantitySummary(mattressesReceived, (line) => line.size) },
      { label: "Total bundles made", value: countValue(mattressesCompleted, "quantity", "bundle") },
      { label: "Bundles made by size", value: groupedQuantitySummary(mattressesCompleted, (line) => line.size) },
    ];
  }

  const completedStock = lines("completed_stock");
  const dispatches = lines("dispatches");
  const invoiceKeys = new Set(dispatches.map((line) => `${line.customer_name}::${line.invoice_number}`));
  return [
    { label: "Total completed stock added", value: countValue(completedStock, "quantity", "pc", "pcs") },
    { label: "Completed stock by size", value: groupedQuantitySummary(completedStock, (line) => line.size) },
    { label: "Total quantity ordered", value: countValue(dispatches, "ordered_quantity", "pc", "pcs") },
    { label: "Total pieces loaded and dispatched", value: countValue(dispatches, "loaded_quantity", "pc", "pcs") },
    { label: "Customer invoices dispatched", value: `${invoiceKeys.size}` },
  ];
}
