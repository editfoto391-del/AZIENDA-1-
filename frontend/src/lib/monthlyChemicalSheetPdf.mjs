import { MONTHLY_SHEET_BLOCKS, MONTHLY_SHEET_CHEMICALS } from "./monthlyChemicalSheet.mjs";
import { documentFilename } from "./format.js";

const quantity = (value) => value == null
  ? "-"
  : Number(value).toLocaleString("en-ZA", { maximumFractionDigits: 2 });

function drawTable(pdf, { title, headers, rows, widths, y }) {
  const margin = 12;
  const pageHeight = pdf.internal.pageSize.getHeight();
  const drawHeader = (top) => {
    pdf.setFillColor(247, 234, 209);
    pdf.setDrawColor(190, 190, 190);
    let x = margin;
    headers.forEach((header, index) => {
      pdf.rect(x, top, widths[index], 9, "FD");
      pdf.setTextColor(35, 35, 35);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7);
      pdf.text(String(header), x + 1.5, top + 5.8, { maxWidth: widths[index] - 3 });
      x += widths[index];
    });
  };
  const drawTitle = (top) => {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.setTextColor(30, 48, 40);
    pdf.text(title, margin, top);
  };
  drawTitle(y);
  let top = y + 3;
  drawHeader(top);
  top += 9;
  rows.forEach((row) => {
    if (top + 8 > pageHeight - 12) {
      pdf.addPage("a4", "landscape");
      top = 14;
      drawTitle(top);
      top += 3;
      drawHeader(top);
      top += 9;
    }
    let x = margin;
    row.forEach((value, index) => {
      pdf.setDrawColor(210, 210, 210);
      pdf.rect(x, top, widths[index], 8);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(45, 45, 45);
      pdf.text(String(value ?? "-"), x + 1.5, top + 5.4, {
        maxWidth: widths[index] - 3,
      });
      x += widths[index];
    });
    top += 8;
  });
  return top + 7;
}

export function createMonthlyChemicalSheetPdf(sheet, totals) {
  return import("jspdf").then(({ jsPDF }) => {
    const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const margin = 12;
    const pageWidth = pdf.internal.pageSize.getWidth();
    pdf.setFillColor(20, 72, 58);
    pdf.rect(0, 0, pageWidth, 20, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(15);
    pdf.text("MONTHLY PRODUCTION & CHEMICAL BALANCE", margin, 9);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(`Month: ${sheet.month}`, margin, 16);

    let y = 28;
    y = drawTable(pdf, {
      title: "1. CHEMICAL ARRIVALS (kg)",
      headers: ["Chemical", "Manual (kg)", "From GRVs (kg)", "Total arrivals (kg)"],
      rows: MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => [
        label,
        quantity(totals.chemicalBalances[key].manualArrival),
        quantity(totals.chemicalBalances[key].importedArrival),
        quantity(totals.chemicalBalances[key].arrival),
      ]),
      widths: [66, 55, 55, 65],
      y,
    });
    if (sheet.arrival_sources?.length) {
      y = drawTable(pdf, {
        title: "IMPORTED CHEMICAL RECEIPTS",
        headers: ["GRV", "Received", "Supplier", "Product / chemical", "Quantity (kg)"],
        rows: sheet.arrival_sources.flatMap((source) => source.lines.map((line) => [
          source.grv_number,
          source.received_date,
          source.supplier_name,
          `${line.product || ""} / ${MONTHLY_SHEET_CHEMICALS.find(({ key }) => key === line.chemical_key)?.label || line.chemical_key}`,
          quantity(line.quantity_kg),
        ])),
        widths: [38, 34, 55, 87, 30],
        y,
      });
    }
    const containerRows = (totals.containerTracking || []).flatMap((tracking) =>
      tracking.containers.map((container) => [
        container.grv_number,
        tracking.chemical_label,
        container.container_type || "Container",
        quantity(container.container_capacity),
        quantity(container.container_count),
        quantity(container.total_quantity_kg),
        tracking.missing_rates.length ? "-" : quantity(container.estimated_used_kg),
        tracking.missing_rates.length ? "-" : quantity(container.remaining_quantity_kg),
        tracking.missing_rates.length
          ? "FORMULA NEEDED"
          : container.depletion_week ? `WEEK ${container.depletion_week}`
            : container.status === "empty" ? "EMPTY" : "NOT EMPTY THIS MONTH",
      ]),
    );
    if (containerRows.length) {
      y = drawTable(pdf, {
        title: "ESTIMATED CHEMICAL CONTAINER USAGE",
        headers: ["GRV", "Chemical", "Container", "Capacity kg", "Count", "Received kg", "Used kg", "Remaining kg", "Estimate"],
        rows: containerRows,
        widths: [28, 31, 25, 20, 15, 23, 21, 25, 40],
        y,
      });
    }
    y = drawTable(pdf, {
      title: "2. WEEKLY PRODUCTION",
      headers: ["Week", ...["Big B", "Blue B", "Medium", "Small", "Sm Blue"]
        .flatMap((label) => [`${label} pcs`, `${label} kg`]), "Total pcs", "Total kg"],
      rows: [
        ...sheet.weeks.map((week, weekIndex) => {
          const weekTotals = MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) => ({
            quantity: sum.quantity + (Number(week[key].quantity) || 0),
            weight: sum.weight + (Number(week[key].weight_kg) || 0),
          }), { quantity: 0, weight: 0 });
          return [
            `Week ${weekIndex + 1}`,
            ...MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
              quantity(Number(week[key].quantity) || 0),
              quantity(Number(week[key].weight_kg) || 0),
            ]),
            quantity(weekTotals.quantity),
            quantity(weekTotals.weight),
          ];
        }),
        [
          "MONTH TOTAL",
          ...MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
            quantity(totals.blockTotals[key].quantity),
            quantity(totals.blockTotals[key].weight_kg),
          ]),
          quantity(totals.totalBlocks),
          quantity(totals.totalBlockWeight),
        ],
      ],
      widths: [24, ...Array(10).fill(17), 22, 22],
      y,
    });
    if (y > pdf.internal.pageSize.getHeight() - 12) {
      pdf.addPage("a4", "landscape");
      y = 14;
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(65, 65, 65);
    pdf.text("Production columns: Big B = Big Block; Blue B = Big Blue Block; Sm Blue = Small Blue Block.", margin, y);

    pdf.addPage("a4", "landscape");
    pdf.setFillColor(20, 72, 58);
    pdf.rect(0, 0, pageWidth, 20, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(15);
    pdf.text("MONTHLY CHEMICAL BALANCE", margin, 9);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(`Month: ${sheet.month}`, margin, 16);

    y = 28;
    y = drawTable(pdf, {
      title: "3. VERIFIED CHEMICAL FORMULA (kg per block)",
      headers: ["Production block", ...MONTHLY_SHEET_CHEMICALS.map(({ label }) => label)],
      rows: MONTHLY_SHEET_BLOCKS.map(({ key, label }) => [
        label,
        ...MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey }) => quantity(sheet.formula_rates[key][chemicalKey])),
      ]),
      widths: [60, ...Array(6).fill(34)],
      y,
    });
    drawTable(pdf, {
      title: "4. MONTH-END CHEMICAL BALANCE",
      headers: ["Chemical", "Arrivals (kg)", "Consumption (kg)", "Remaining (kg)", "Reorder below (kg)", "Status"],
      rows: MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => {
        const balance = totals.chemicalBalances[key];
        const status = balance.status === "ok" ? "STOCK OK"
          : balance.status === "reorder" ? "REORDER"
            : balance.status === "missing-formula" ? `FORMULA NEEDED: ${balance.missingRates.join(", ")}`
              : balance.status === "missing-arrival" ? "ENTER ARRIVALS" : "SET MINIMUM";
        return [
          label,
          quantity(balance.arrival),
          quantity(balance.consumption),
          quantity(balance.remaining),
          quantity(balance.minimum),
          status,
        ];
      }),
      widths: [42, 34, 38, 38, 42, 68],
      y,
    });
    return pdf;
  });
}

export async function downloadMonthlyChemicalSheetPdf(sheet, totals) {
  const pdf = await createMonthlyChemicalSheetPdf(sheet, totals);
  pdf.save(`${documentFilename("monthly-production-chemical-balance", sheet.month)}.pdf`);
}
