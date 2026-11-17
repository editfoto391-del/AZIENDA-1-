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

function pdfProductionRows(sheet) {
  const [year, month] = sheet.month.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const weekIndexOf = (day) => day.week_index
    ?? Math.floor((mondayOffset + Number(day.date.slice(-2)) - 1) / 7);
  return Array.from({ length: sheet.weeks.length }, (_, weekIndex) => {
    const days = (sheet.production_days || [])
      .filter((day) => weekIndexOf(day) === weekIndex);
    const hasDailyEntries = days.some((day) => MONTHLY_SHEET_BLOCKS.some(({ key }) =>
      day[key].quantity != null && day[key].quantity !== ""
        || day[key].weight_kg != null && day[key].weight_kg !== ""));
    if (hasDailyEntries) {
      return days.filter((day) => MONTHLY_SHEET_BLOCKS.some(({ key }) =>
        day[key].quantity != null && day[key].quantity !== ""
          || day[key].weight_kg != null && day[key].weight_kg !== ""))
        .map((day) => {
          const totals = MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) => ({
            quantity: sum.quantity + (Number(day[key].quantity) || 0),
            weight: sum.weight + (Number(day[key].weight_kg) || 0),
          }), { quantity: 0, weight: 0 });
          return [
            `Week ${weekIndex + 1}`,
            day.date,
            ...MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
              quantity(Number(day[key].quantity) || 0),
              quantity(Number(day[key].weight_kg) || 0),
            ]),
            quantity(totals.quantity),
            quantity(totals.weight),
          ];
        });
    }

    const legacyWeek = sheet.weeks[weekIndex];
    const hasLegacyEntries = MONTHLY_SHEET_BLOCKS.some(({ key }) =>
      legacyWeek[key].quantity != null && legacyWeek[key].quantity !== ""
        || legacyWeek[key].weight_kg != null && legacyWeek[key].weight_kg !== "");
    if (hasLegacyEntries) {
      const totals = MONTHLY_SHEET_BLOCKS.reduce((sum, { key }) => ({
        quantity: sum.quantity + (Number(legacyWeek[key].quantity) || 0),
        weight: sum.weight + (Number(legacyWeek[key].weight_kg) || 0),
      }), { quantity: 0, weight: 0 });
      return [[
        `Week ${weekIndex + 1} (legacy)`,
        "Date not recorded",
        ...MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
          quantity(Number(legacyWeek[key].quantity) || 0),
          quantity(Number(legacyWeek[key].weight_kg) || 0),
        ]),
        quantity(totals.quantity),
        quantity(totals.weight),
      ]];
    }
    return days.map((day) => [
      `Week ${weekIndex + 1}`,
      day.date,
      ...MONTHLY_SHEET_BLOCKS.flatMap(() => ["-", "-"]),
      "0",
      "0",
    ]);
  }).flat();
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
    const usageRows = (totals.containerTracking || []).flatMap((tracking) =>
      tracking.usage_by_block.map((usage) => [
        tracking.chemical_label,
        usage.block_label,
        quantity(usage.blocks_produced),
        quantity(usage.formula_rate_kg_per_block),
        usage.formula_missing ? "FORMULA NEEDED" : quantity(usage.used_kg),
      ]),
    );
    if (usageRows.length) {
      y = drawTable(pdf, {
        title: "ACTUAL CHEMICAL USE BY PRODUCTION BLOCK",
        headers: ["Chemical", "Block size", "Blocks produced", "Formula kg / block", "Actually used (kg)"],
        rows: usageRows,
        widths: [55, 55, 45, 50, 50],
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
        tracking.missing_rates.length ? "-" : quantity(container.actually_used_kg),
        tracking.missing_rates.length ? "-" : quantity(container.remaining_quantity_kg),
        tracking.missing_rates.length || !container.container_data_consistent
          ? "-" : quantity(container.containers_with_stock),
        tracking.missing_rates.length || !container.container_data_consistent
          ? "-" : quantity(container.empty_container_count),
        tracking.missing_rates.length
          ? "FORMULA NEEDED"
          : !container.container_data_consistent ? "CHECK GRV DETAILS"
            : container.depletion_week ? `WEEK ${container.depletion_week}`
              : container.status === "empty" ? "EMPTY" : "NOT EMPTY THIS MONTH",
      ]),
    );
    if (containerRows.length) {
      y = drawTable(pdf, {
        title: "CHEMICAL AND CONTAINER BALANCE",
        headers: [
          "GRV", "Chemical", "Container / drum", "Capacity kg", "Received count",
          "Received kg", "Used kg", "Remaining kg", "Containers remaining", "Empty containers", "Depletion",
        ],
        rows: containerRows,
        widths: [28, 31, 25, 20, 15, 23, 21, 25, 18, 18, 28],
        y,
      });
    }
    y = drawTable(pdf, {
      title: "2. DAILY PRODUCTION",
      headers: ["Week", "Date", ...["Big B", "Blue B", "Medium", "Small", "Sm Blue"]
        .flatMap((label) => [`${label} pcs`, `${label} kg`]), "Total pcs", "Total kg"],
      rows: [
        ...pdfProductionRows(sheet),
        [
          "MONTH TOTAL",
          "",
          ...MONTHLY_SHEET_BLOCKS.flatMap(({ key }) => [
            quantity(totals.blockTotals[key].quantity),
            quantity(totals.blockTotals[key].weight_kg),
          ]),
          quantity(totals.totalBlocks),
          quantity(totals.totalBlockWeight),
        ],
      ],
      widths: [36, 24, ...Array(10).fill(17), 22, 22],
      y,
    });
    if (y > pdf.internal.pageSize.getHeight() - 12) {
      pdf.addPage("a4", "landscape");
      y = 14;
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(65, 65, 65);
    pdf.text("Production columns: Big B = Big Block; Blue B = Big Blue Block; Sm Blue = Small Blue Block. Legacy weekly totals have no recorded production date.", margin, y);

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
          : balance.status === "finished" ? "FINISHED"
            : balance.status === "reorder" ? "RE-ORDER AS SOON AS POSSIBLE"
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

export async function createDailyChemicalAndBlockPdf(report) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
  });
  const margin = 12;
  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(20, 72, 58);
  pdf.rect(0, 0, pageWidth, 20, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(15);
  pdf.text("DAILY CHEMICAL & BLOCK REPORT", margin, 9);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(`Date: ${report.date}`, margin, 16);

  let y = 28;
  y = drawTable(pdf, {
    title: "BLOCKS PRODUCED",
    headers: ["Block type", "Blocks made", "Weight (kg)"],
    rows: [
      ...report.blocks.map((block) => [
        block.label,
        quantity(block.quantity),
        quantity(block.weight_kg),
      ]),
      ["DAILY TOTAL", quantity(report.totalBlocks), quantity(report.totalWeightKg)],
    ],
    widths: [78, 42, 42],
    y,
  });

  y = drawTable(pdf, {
    title: "CHEMICAL USED TODAY",
    headers: [
      "Chemical",
      ...(report.chemicalUsage[0]?.byBlock || []).map((block) => block.block_label),
      "Used today (kg)",
      "Formula status",
    ],
    rows: report.chemicalUsage.map((usage) => [
      usage.label,
      ...usage.byBlock.map((block) => quantity(block.used_kg)),
      quantity(usage.used_today_kg),
      usage.missingRates.length
        ? `FORMULA NEEDED: ${usage.missingRates.join(", ")}`
        : "Complete",
    ]),
    widths: [
      32,
      ...(report.chemicalUsage[0]?.byBlock || []).map(() => 26),
      30,
      81,
    ],
    y,
  });

  y = drawTable(pdf, {
    title: "CHEMICAL BALANCE AT END OF DAY",
    headers: ["Chemical", "Remaining (kg)", "Containers with stock", "GRV-tracked kg remaining", "Status"],
    rows: report.balances.map((balance) => [
      balance.label,
      quantity(balance.remaining_kg),
      quantity(balance.barrels_remaining),
      quantity(balance.tracked_remaining_kg),
      balance.missingRates.length
        ? `FORMULA NEEDED: ${balance.missingRates.join(", ")}`
        : balance.hasContainerMismatch ? "CHECK GRV DETAILS" : "Estimate",
    ]),
    widths: [44, 44, 48, 58, 60],
    y,
  });

  if (y > pdf.internal.pageSize.getHeight() - 12) {
    pdf.addPage("a4", "landscape");
    y = 14;
  }
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);
  pdf.setTextColor(65, 65, 65);
  pdf.text(
    "Balances exclude opening stock and weekly production without dates. Container quantities are GRV-based estimates, not physical counts.",
    margin,
    y,
    { maxWidth: pageWidth - margin * 2 },
  );
  return pdf;
}

export async function downloadDailyChemicalAndBlockPdf(report) {
  const pdf = await createDailyChemicalAndBlockPdf(report);
  pdf.save(`${documentFilename("daily-chemical-and-block-report", report.date)}.pdf`);
}
