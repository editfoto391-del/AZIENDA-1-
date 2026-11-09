const NAVY = [19, 43, 65];
const BRAND = [31, 54, 70];
const GRID = [205, 212, 216];
const SECTION_STYLES = {
  "01": { accent: [67, 137, 165], background: [220, 236, 244] },
  "02": { accent: [77, 149, 107], background: [223, 241, 229] },
  "03": { accent: [177, 132, 84], background: [247, 233, 216] },
  "04": { accent: [112, 100, 155], background: [231, 227, 242] },
};
const ROWS_PER_PAGE = 12;
const CELL_FONT_SIZE = 5.8;
const LINE_HEIGHT = 2.7;
const BODY_HEIGHT = 49.5;
const ROW_HEIGHT = BODY_HEIGHT / ROWS_PER_PAGE;

function sectionRows(report, mainInvoiceNo) {
  return [
    {
      number: "01",
      title: "DAILY SENDING INVOICES",
      columns: [
        { label: "NO", width: 0.08, value: (_row, index) => index + 1 },
        { label: "INVOICE NO.", width: 0.2, value: (row) => row.number },
        { label: "CLIENT DESCRIPTION", width: 0.46, value: (row) => row.client_name },
        { label: "AMOUNT", width: 0.26, value: (row) => money(row.amount), align: "right" },
      ],
      rows: report.invoices || [],
      totalLabel: "Total Sending",
      total: money(report.totals?.sending),
      footerNote: `Main Invoice No.  ${mainInvoiceNo || "-"}`,
    },
    {
      number: "02",
      title: "DAILY RECEIVING / CLIENT PAYMENTS",
      columns: [
        { label: "NO", width: 0.08, value: (_row, index) => index + 1 },
        { label: "CLIENT NAME", width: 0.27, value: (row) => row.client_name },
        { label: "INV. NO.", width: 0.17, value: (row) => row.invoice_number },
        { label: "AMOUNT", width: 0.2, value: (row) => money(row.amount), align: "right" },
        { label: "NOTES", width: 0.28, value: (row) => row.notes },
      ],
      rows: report.payments || [],
      totalLabel: "Total Received",
      total: money(report.totals?.received),
    },
    {
      number: "03",
      title: "EXPENSES BREAKDOWN",
      columns: [
        { label: "NO", width: 0.08, value: (_row, index) => index + 1 },
        { label: "CATEGORY", width: 0.25, value: (row) => row.category },
        { label: "DESCRIPTION", width: 0.41, value: (row) => row.description },
        { label: "AMOUNT", width: 0.26, value: (row) => money(row.amount), align: "right" },
      ],
      rows: report.expenses || [],
      totalLabel: "Total Expenses",
      total: money(report.totals?.expenses),
    },
    {
      number: "04",
      title: "DIESEL USAGE (BY VEHICLE)",
      columns: [
        { label: "VEHICLE", width: 0.56, value: (row, index) => `${index + 1}. ${row.vehicle}` },
        { label: "AMOUNT", width: 0.2, value: (row) => money(row.amount), align: "right" },
        { label: "NOTES", width: 0.24, value: (row) => row.notes },
      ],
      rows: report.diesel_usage || [],
      totalLabel: "Total Diesel",
      total: money(report.totals?.diesel),
    },
  ];
}

function money(value) {
  return `R ${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function paginateRows(pdf, section, width) {
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(CELL_FONT_SIZE);
  const rows = section.rows.map((row, index) => {
    const lines = section.columns.map((column) => {
      const value = String(column.value(row, index) ?? "");
      return value ? pdf.splitTextToSize(value, Math.max(2, width * column.width - 2.4)) : [""];
    });
    const maxLines = Math.floor((BODY_HEIGHT - 0.8) / LINE_HEIGHT);
    const segmentCount = Math.max(1, ...lines.map((cellLines) => Math.ceil(cellLines.length / maxLines)));
    return Array.from({ length: segmentCount }, (_, segmentIndex) => {
      const segmentLines = lines.map((cellLines) => {
        const chunk = cellLines.slice(segmentIndex * maxLines, (segmentIndex + 1) * maxLines);
        return chunk.length ? chunk : [""];
      });
      const lineCount = Math.max(1, ...segmentLines.map((cellLines) => cellLines.length));
      return {
        lines: segmentLines,
        sourceIndex: index,
        continuation: segmentIndex > 0,
        height: Math.max(ROW_HEIGHT, lineCount * LINE_HEIGHT + 0.8),
      };
    });
  }).flat();
  if (!rows.length) return [[]];

  const pages = [];
  let currentPage = [];
  let usedHeight = 0;
  rows.forEach((row) => {
    if (currentPage.length && usedHeight + row.height > BODY_HEIGHT) {
      pages.push(currentPage);
      currentPage = [];
      usedHeight = 0;
    }
    currentPage.push(row);
    usedHeight += row.height;
  });
  if (currentPage.length) pages.push(currentPage);
  return pages;
}

function drawSection(pdf, section, pageRows, x, y, width, height, pageIndex) {
  const colors = SECTION_STYLES[section.number];
  const titleHeight = 8;
  const columnHeight = 7;
  const footerHeight = section.footerNote ? 14 : 7;
  const bodyHeight = height - titleHeight - columnHeight - footerHeight;
  const rows = pageRows[pageIndex] || [];

  pdf.setDrawColor(...GRID);
  pdf.setLineWidth(0.28);
  pdf.rect(x, y, width, height);
  pdf.setFillColor(...colors.background);
  pdf.rect(x, y, width, titleHeight, "F");
  pdf.setFillColor(...colors.accent);
  pdf.rect(x + 1, y + 1.3, 8, 5.4, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(6.5);
  pdf.text(section.number, x + 5, y + 5, { align: "center" });
  pdf.setFontSize(7.2);
  pdf.text(section.title, x + 11, y + 5.3);

  const columnsY = y + titleHeight;
  pdf.setFillColor(255, 255, 255);
  pdf.rect(x, columnsY, width, columnHeight, "F");
  pdf.setTextColor(38, 48, 56);
  let columnX = x;
  pdf.setFontSize(5.8);
  for (const column of section.columns) {
    const cellWidth = width * column.width;
    pdf.setDrawColor(...GRID);
    pdf.rect(columnX, columnsY, cellWidth, columnHeight);
    pdf.setTextColor(38, 48, 56);
    pdf.text(column.label, columnX + 1.2, columnsY + 4.5);
    columnX += cellWidth;
  }

  const rowsY = columnsY + columnHeight;
  let currentRowY = rowsY;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    let cellX = x;
    section.columns.forEach((column, columnIndex) => {
      const cellWidth = width * column.width;
      pdf.setDrawColor(...GRID);
      pdf.rect(cellX, currentRowY, cellWidth, row.height);
      const lines = [...row.lines[columnIndex]];
      if (columnIndex === 0 && column.label === "NO") {
        lines[0] = row.continuation ? "" : String(row.sourceIndex + 1);
      } else if (columnIndex === 0 && row.continuation) {
        lines[0] = "";
      }
      pdf.setTextColor(25, 33, 40);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(CELL_FONT_SIZE);
      pdf.text(lines, column.align === "right" ? cellX + cellWidth - 1.2 : cellX + 1.2, currentRowY + 2.6, {
        align: column.align || "left",
        lineHeightFactor: 1,
      });
      cellX += cellWidth;
    });
    currentRowY += row.height;
  }

  const emptyRowCount = Math.max(0, ROWS_PER_PAGE - rows.length);
  for (let rowIndex = 0; rowIndex < emptyRowCount; rowIndex += 1) {
    const remainingHeight = rowsY + bodyHeight - currentRowY;
    const blankHeight = remainingHeight / (emptyRowCount - rowIndex);
    let cellX = x;
    section.columns.forEach((column, columnIndex) => {
      const cellWidth = width * column.width;
      pdf.setDrawColor(...GRID);
      pdf.rect(cellX, currentRowY, cellWidth, blankHeight);
      if (columnIndex === 0) {
        pdf.setTextColor(25, 33, 40);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(CELL_FONT_SIZE);
        pdf.text(String(rows.length + rowIndex + 1), cellX + 1.2, currentRowY + blankHeight * 0.65);
      }
      cellX += cellWidth;
    });
    currentRowY += blankHeight;
  }

  const footerY = rowsY + bodyHeight;
  pdf.setFillColor(...colors.background);
  pdf.rect(x, footerY, width, footerHeight, "F");
  pdf.setDrawColor(...GRID);
  pdf.rect(x, footerY, width, section.footerNote ? 7 : footerHeight);
  pdf.setTextColor(25, 33, 40);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(6.2);
  pdf.text(section.totalLabel, x + 2, footerY + 4.5);
  pdf.text(section.total, x + width - 2, footerY + 4.5, { align: "right" });
  if (section.footerNote) {
    pdf.rect(x, footerY + 7, width, footerHeight - 7);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(5.8);
    pdf.setFont("helvetica", "bold");
    pdf.text("Main Invoice No.", x + 2, footerY + 11.5);
    pdf.setFont("helvetica", "normal");
    pdf.text(String(section.footerNote).replace(/^Main Invoice No\.\s*/, ""), x + 28, footerY + 11.5);
  }
}

export async function downloadDailyReportPdf(report, mainInvoiceNo) {
  if (!report) throw new Error("Daily report data is not available.");
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const sections = sectionRows(report, mainInvoiceNo);
  const mainSections = sections;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 9;
  const gapX = 4;
  const gapY = 4;
  const sectionWidth = (pageWidth - margin * 2 - gapX) / 2;
  const sectionHeight = 78.5;
  const top = 36;
  const sectionPages = mainSections.map((section) => paginateRows(pdf, section, sectionWidth));
  const pageCount = Math.max(1, ...sectionPages.map((pages) => pages.length));

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    if (pageIndex > 0) pdf.addPage("a4", "landscape");
    pdf.setTextColor(...BRAND);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.text(report.company_name || "SUPER IQ-FOAM", pageWidth / 2, 10, { align: "center" });
    pdf.setTextColor(38, 43, 48);
    pdf.setFontSize(11);
    pdf.text(pageIndex ? "DAILY REPORT (CONTINUED)" : "DAILY REPORT", pageWidth / 2, 17, { align: "center" });
    pdf.setDrawColor(90, 96, 101);
    pdf.line(margin, 25, pageWidth - margin, 25);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.text(`Date: ${report.date}`, margin, 31);
    pdf.text(`Day: ${report.day || ""}`, pageWidth / 2, 31, { align: "center" });
    pdf.text(`Company: ${report.company_name || "SUPER IQ-FOAM"}`, pageWidth - margin, 31, { align: "right" });

    mainSections.forEach((section, index) => {
      const x = margin + (index % 2) * (sectionWidth + gapX);
      const y = top + Math.floor(index / 2) * (sectionHeight + gapY);
      drawSection(pdf, section, sectionPages[index], x, y, sectionWidth, sectionHeight, pageIndex);
    });
  }

  const companyFileName = (report.company_name || "SUPERIQFOAM").replace(/[^a-z0-9]+/gi, "_");
  pdf.save(`${companyFileName}_Daily_Report_${report.date}.pdf`);
}
