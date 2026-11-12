function formatMoney(value) {
  return `R ${Number(value || 0).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function percentage(value, total) {
  return total > 0 ? `${((value / total) * 100).toLocaleString("en-ZA", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%` : "—";
}

function periodTitle(report) {
  const start = new Date(`${report.start}T12:00:00`);
  const month = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(start);
  if (report.period === "monthly") return `Monthly Performance Report — ${month}`;
  return `Weekly Performance Report — ${report.start} to ${report.end}`;
}

export function buildFinancialReportPdfData(report) {
  if (!report?.summary || !report?.transactions) {
    throw new Error("Financial report data is not available.");
  }
  const { summary, transactions } = report;
  const sales = Number(summary.total_invoices) || 0;
  const expenseGroups = new Map();
  (transactions.expenses || []).forEach((expense) => {
    const category = String(expense.category || "Other / Uncategorised").trim() || "Other / Uncategorised";
    expenseGroups.set(category, (expenseGroups.get(category) || 0) + (Number(expense.amount) || 0));
  });
  const expenses = [...expenseGroups]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => a.category.localeCompare(b.category));
  const profit = summary.final_profit == null ? null : Number(summary.final_profit);
  return {
    companyName: report.company_name || "Company",
    title: periodTitle(report),
    period: `${report.start} — ${report.end}`,
    generatedAt: report.generated_at ? new Date(report.generated_at).toLocaleString("en-ZA") : "",
    metrics: [
      { label: "TOTAL INVOICED / SALES", value: formatMoney(summary.total_invoices) },
      { label: "TOTAL PAYMENTS RECEIVED", value: formatMoney(summary.payments_received) },
      { label: "OUTSTANDING BALANCES", value: formatMoney(summary.pending_payments) },
      { label: "TOTAL EXPENSES", value: formatMoney(summary.expenses) },
      { label: "ESTIMATED PROFIT", value: profit == null ? "Unavailable" : formatMoney(profit) },
      { label: "PROFIT MARGIN · OF SALES", value: profit == null || sales <= 0 ? "—" : percentage(profit, sales) },
    ],
    overview: [
      { label: "Total Invoiced / Sales", amount: summary.total_invoices },
      { label: "Total Payments Received", amount: summary.payments_received },
      { label: "Outstanding Balances · all issued invoices", amount: summary.pending_payments },
      { label: "Business Expenses", amount: summary.expenses },
      { label: "Buyings", amount: summary.buyings },
      { label: "Calculated Salaries", amount: summary.salaries },
      { label: "Accepted GRV Costs", amount: summary.grv },
      { label: "Estimated Company Profit", amount: profit },
    ].map((row) => ({
      ...row,
      percent: row.amount == null ? "—" : percentage(Number(row.amount) || 0, sales),
    })),
    expenses,
    diesel: (report.diesel_usage || []).map((row) => ({
      vehicle: row.vehicle || "Unassigned vehicle",
      records: Number(row.records) || 0,
      amount: Number(row.amount) || 0,
    })),
    chart: [
      { label: "Total Sales", value: sales, color: [38, 76, 125] },
      { label: "Total Expenses", value: Number(summary.expenses) || 0, color: [208, 170, 83] },
      { label: "Estimated Profit", value: profit || 0, color: [105, 151, 79] },
    ],
    notes: report.accounting_notes || [],
    profitAvailable: profit != null,
  };
}

const COLORS = {
  navy: [30, 55, 96],
  navyLight: [43, 72, 117],
  text: [38, 49, 63],
  muted: [105, 116, 130],
  border: [209, 216, 224],
  blueTint: [225, 235, 246],
  goldTint: [255, 244, 211],
  greenTint: [231, 242, 222],
  white: [255, 255, 255],
  row: [246, 248, 251],
};

function drawHeader(pdf, data, pageNumber) {
  const width = pdf.internal.pageSize.getWidth();
  pdf.setFillColor(...COLORS.navy);
  pdf.roundedRect(12, 10, width - 24, 22, 1.5, 1.5, "F");
  pdf.setTextColor(...COLORS.white);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(pdf.splitTextToSize(data.companyName, width - 34), 17, 19);
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "normal");
  pdf.text(pdf.splitTextToSize(data.title, width - 34), 17, 27);
  pdf.setTextColor(...COLORS.muted);
  pdf.setFontSize(8);
  pdf.text(`Period: ${data.period}`, 12, 38);
  pdf.text(`Generated: ${data.generatedAt}`, width - 12, 38, { align: "right" });
  pdf.setDrawColor(199, 164, 79);
  pdf.setLineWidth(1);
  pdf.line(12, 42, width - 12, 42);
  pdf.setFontSize(7);
  pdf.setTextColor(...COLORS.muted);
  pdf.text(`Page ${pageNumber}`, width - 12, pdf.internal.pageSize.getHeight() - 7, { align: "right" });
}

function drawSectionTitle(pdf, title, x, y, width) {
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(...COLORS.navy);
  pdf.text(title.toUpperCase(), x, y);
  return y + 4;
}

function startSection(pdf, data, title, y, margin, width) {
  if (y + 22 > pdf.internal.pageSize.getHeight() - 14) {
    pdf.addPage();
    drawHeader(pdf, data, pdf.getNumberOfPages());
    y = 49;
  }
  return drawSectionTitle(pdf, title, margin, y, width);
}

function drawMetrics(pdf, metrics, y, margin, width) {
  const gap = 2;
  const cellWidth = (width - gap) / 2;
  const cellHeight = 15;
  const fills = [COLORS.blueTint, COLORS.blueTint, COLORS.goldTint, COLORS.blueTint, COLORS.greenTint, COLORS.greenTint];
  metrics.forEach((metric, index) => {
    const row = Math.floor(index / 2);
    const column = index % 2;
    const x = margin + column * (cellWidth + gap);
    const cellY = y + row * (cellHeight + gap);
    pdf.setFillColor(...fills[index]);
    pdf.roundedRect(x, cellY, cellWidth, cellHeight, 1, 1, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.setTextColor(...COLORS.muted);
    pdf.text(metric.label, x + cellWidth / 2, cellY + 5, { align: "center" });
    pdf.setFontSize(13);
    pdf.setTextColor(...COLORS.navy);
    pdf.text(pdf.splitTextToSize(metric.value, cellWidth - 8), x + cellWidth / 2, cellY + 11, { align: "center" });
  });
  return y + 3 * cellHeight + 2 * gap;
}

function drawTable(pdf, data, {
  x, y, width, columns, rows, rowHeight = 6, emptyText, totalRow,
}) {
  const pageHeight = pdf.internal.pageSize.getHeight();
  const bottom = pageHeight - 14;
  const headerHeight = 8;
  if (y + headerHeight + rowHeight > bottom) {
    pdf.addPage();
    drawHeader(pdf, data, pdf.getNumberOfPages());
    y = 49;
  }
  const drawTableHeader = () => {
    pdf.setFillColor(...COLORS.navy);
    pdf.rect(x, y, width, headerHeight, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...COLORS.white);
    columns.forEach((column) => {
      const cellX = x + width * column.start;
      const cellWidth = width * column.width;
      pdf.text(column.label, column.align === "right" ? cellX + cellWidth - 2 : cellX + 2, y + 5.3, {
        align: column.align || "left",
      });
    });
    y += headerHeight;
  };
  drawTableHeader();
  const tableRows = [
    ...(rows.length ? rows : [{ emptyText }]),
    ...(totalRow ? [{ ...totalRow, isTotal: true }] : []),
  ];
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  tableRows.forEach((row, index) => {
    const isEmpty = !rows.length && !row.isTotal;
    const linesByColumn = columns.map((column) => {
      const value = isEmpty ? (column.start === 0 ? emptyText : "") : String(column.value(row) ?? "");
      return pdf.splitTextToSize(value, Math.max(4, width * column.width - 4));
    });
    const currentHeight = Math.max(rowHeight, ...linesByColumn.map((lines) => lines.length * 3.2 + 2));
    if (y + currentHeight > bottom) {
      pdf.addPage();
      drawHeader(pdf, data, pdf.getNumberOfPages());
      y = 49;
      drawTableHeader();
    }
    if (row.isTotal || (index % 2 === 1 && rows.length)) {
      pdf.setFillColor(...(row.isTotal ? COLORS.greenTint : COLORS.row));
      pdf.rect(x, y, width, currentHeight, "F");
    }
    pdf.setDrawColor(...COLORS.border);
    pdf.setLineWidth(0.2);
    pdf.line(x, y + currentHeight, x + width, y + currentHeight);
    columns.forEach((column, columnIndex) => {
      const cellX = x + width * column.start;
      const cellWidth = width * column.width;
      pdf.setTextColor(...(row.isTotal ? COLORS.navy : COLORS.text));
      pdf.setFont("helvetica", row.isTotal ? "bold" : "normal");
      pdf.text(linesByColumn[columnIndex], column.align === "right" ? cellX + cellWidth - 2 : cellX + 2, y + 4.7, {
        align: column.align || "left",
        lineHeightFactor: 1.1,
      });
    });
    y += currentHeight;
  });
  return y + 2;
}

export async function downloadFinancialReportPdf(report) {
  const data = buildFinancialReportPdfData(report);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  drawHeader(pdf, data, 1);
  let y = 47;
  y = drawMetrics(pdf, data.metrics, y, margin, contentWidth);

  y = startSection(pdf, data, "1. Financial Overview", y + 5, margin, contentWidth);
  y = drawTable(pdf, data, {
    x: margin,
    y,
    width: contentWidth,
    columns: [
      { label: "Item", start: 0, width: 0.55, value: (row) => row.label },
      { label: "Amount", start: 0.55, width: 0.27, align: "right", value: (row) => row.amount == null ? "Unavailable" : formatMoney(row.amount) },
      { label: "% of Sales", start: 0.82, width: 0.18, align: "right", value: (row) => row.percent },
    ],
    rows: data.overview,
  });

  y = startSection(pdf, data, "2. Expense Details", y + 5, margin, contentWidth);
  const expenses = data.expenses.map((row) => ({
    ...row,
    percent: percentage(row.amount, Number(report.summary.expenses) || 0),
  }));
  y = drawTable(pdf, data, {
    x: margin,
    y,
    width: contentWidth,
    columns: [
      { label: "Category", start: 0, width: 0.58, value: (row) => row.category },
      { label: "Amount", start: 0.58, width: 0.24, align: "right", value: (row) => formatMoney(row.amount) },
      { label: "% of Expenses", start: 0.82, width: 0.18, align: "right", value: (row) => row.percent },
    ],
    rows: expenses,
    emptyText: "No expenses recorded in this period.",
    totalRow: {
      category: "TOTAL EXPENSES",
      amount: Number(report.summary.expenses) || 0,
      percent: percentage(Number(report.summary.expenses) || 0, Number(report.summary.expenses) || 0),
    },
  });

  y = startSection(pdf, data, "3. Fuel (Diesel) Costs by Vehicle", y + 5, margin, contentWidth);
  y = drawTable(pdf, data, {
    x: margin,
    y,
    width: contentWidth,
    columns: [
      { label: "Vehicle", start: 0, width: 0.55, value: (row) => row.vehicle },
      { label: "Records", start: 0.55, width: 0.15, align: "right", value: (row) => row.records },
      { label: "Amount", start: 0.7, width: 0.3, align: "right", value: (row) => formatMoney(row.amount) },
    ],
    rows: data.diesel,
    emptyText: "No diesel expenses recorded in this period.",
    totalRow: {
      vehicle: "TOTAL DIESEL",
      records: data.diesel.reduce((total, row) => total + row.records, 0),
      amount: data.diesel.reduce((total, row) => total + row.amount, 0),
    },
  });

  y = startSection(pdf, data, "4. Quick Comparison", y + 5, margin, contentWidth);
  const chartMax = Math.max(0, ...data.chart.map((item) => Math.abs(item.value)));
  const labelWidth = 34;
  const valueWidth = 35;
  const chartWidth = contentWidth - labelWidth - valueWidth - 4;
  const hasNegativeValue = data.chart.some((item) => item.value < 0);
  const chartOrigin = margin + labelWidth + (hasNegativeValue ? chartWidth / 2 : 0);
  const chartScale = hasNegativeValue ? chartWidth / 2 : chartWidth;
  data.chart.forEach((item) => {
    if (y + 8 > pdf.internal.pageSize.getHeight() - 14) {
      pdf.addPage();
      drawHeader(pdf, data, pdf.getNumberOfPages());
      y = 49;
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(...COLORS.text);
    pdf.text(item.label, margin, y + 4.5);
    pdf.setFillColor(239, 242, 246);
    pdf.roundedRect(margin + labelWidth, y + 1, chartWidth, 5, 1, 1, "F");
    if (hasNegativeValue) {
      pdf.setDrawColor(...COLORS.border);
      pdf.line(chartOrigin, y, chartOrigin, y + 7);
    }
    if (chartMax > 0 && item.value !== 0) {
      pdf.setFillColor(...item.color);
      const barWidth = chartScale * Math.abs(item.value) / chartMax;
      pdf.roundedRect(item.value < 0 ? chartOrigin - barWidth : chartOrigin, y + 1, barWidth, 5, 1, 1, "F");
    }
    pdf.text(formatMoney(item.value), pageWidth - margin, y + 4.5, { align: "right" });
    y += 8;
  });

  const filenameCompany = data.companyName.replace(/[^a-z0-9]+/gi, "_");
  const period = report.period === "monthly" ? report.start.slice(0, 7) : `${report.start}_${report.end}`;
  pdf.save(`${filenameCompany}_${report.period === "monthly" ? "Monthly" : "Weekly"}_Performance_Report_${period}.pdf`);
}
