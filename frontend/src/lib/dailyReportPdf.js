const NAVY = [19, 43, 65];
const ORANGE = [181, 83, 43];
const BRAND = [31, 54, 70];
const GRID = [205, 212, 216];
const SECTION_STYLES = {
  "01": { accent: [67, 137, 165], background: [220, 236, 244] },
  "02": { accent: [77, 149, 107], background: [223, 241, 229] },
  "03": { accent: [177, 132, 84], background: [247, 233, 216] },
  "04": { accent: [112, 100, 155], background: [231, 227, 242] },
  H: { accent: [67, 141, 138], background: [220, 239, 237] },
};
const ROWS_PER_PAGE = 12;
const ROW_HEIGHT = 4.65;
const CELL_FONT_SIZE = 5.8;
const LINE_HEIGHT = 2.7;
const BODY_HEIGHT = 49.5;

function sectionRows(report, mainInvoiceNo) {
  return [
    {
      number: "01",
      title: "DAILY SENDING INVOICES",
      columns: [
        { label: "NO", width: 0.08, value: (_row, index) => index + 1 },
        { label: "INVOICE NO.", width: 0.2, value: (row) => row.number },
        { label: "CLIENT / DESCRIPTION", width: 0.46, value: (row) => row.client_name },
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
        { label: "VEHICLE", width: 0.56, value: (row) => row.vehicle },
        { label: "AMOUNT", width: 0.2, value: (row) => money(row.amount), align: "right" },
        { label: "NOTES", width: 0.24, value: (row) => row.notes },
      ],
      rows: report.diesel_usage || [],
      totalLabel: "Total Diesel",
      total: money(report.totals?.diesel),
    },
  ];
}

function homeSection(report) {
  return {
    number: "H",
    title: "HOME",
    columns: [
      { label: "NO", width: 0.08, value: (_row, index) => index + 1 },
      { label: "CATEGORY", width: 0.25, value: (row) => row.category },
      { label: "DESCRIPTION", width: 0.41, value: (row) => row.description },
      { label: "AMOUNT", width: 0.26, value: (row) => money(row.amount), align: "right" },
    ],
    rows: report.home_expenses || [],
    totalLabel: "Total Home",
    total: money(report.totals?.home_expenses),
  };
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
      if (columnIndex === 0 && section.number !== "05") {
        lines[0] = row.continuation ? "" : String(row.sourceIndex + 1);
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

  if (!rows.length) {
    const blankRowHeight = bodyHeight / ROWS_PER_PAGE;
    for (let rowIndex = 0; rowIndex < ROWS_PER_PAGE; rowIndex += 1) {
      let cellX = x;
      section.columns.forEach((column, columnIndex) => {
        const cellWidth = width * column.width;
        pdf.setDrawColor(...GRID);
        pdf.rect(cellX, currentRowY, cellWidth, blankRowHeight);
        if (columnIndex === 0 && section.number !== "05") {
          pdf.setTextColor(25, 33, 40);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(CELL_FONT_SIZE);
          pdf.text(String(rowIndex + 1), cellX + 1.2, currentRowY + blankRowHeight * 0.65);
        }
        cellX += cellWidth;
      });
      currentRowY += blankRowHeight;
    }
  } else {
    let nextRowNumber = (rows[rows.length - 1]?.sourceIndex || 0) + 2;
    while (currentRowY < rowsY + bodyHeight - 0.2) {
      const blankHeight = Math.min(ROW_HEIGHT, rowsY + bodyHeight - currentRowY);
      let cellX = x;
      section.columns.forEach((column, columnIndex) => {
        const cellWidth = width * column.width;
        pdf.setDrawColor(...GRID);
        pdf.rect(cellX, currentRowY, cellWidth, blankHeight);
        if (columnIndex === 0 && section.number !== "04") {
          pdf.setTextColor(25, 33, 40);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(CELL_FONT_SIZE);
          pdf.text(String(nextRowNumber), cellX + 1.2, currentRowY + blankHeight * 0.65);
        }
        cellX += cellWidth;
      });
      currentRowY += blankHeight;
      nextRowNumber += 1;
    }
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

function drawAppendixPages(pdf, report, pageWidth, title, items, descriptionLabel) {
  const pageSize = 18;
  for (let start = 0; start < items.length; start += pageSize) {
    pdf.addPage("a4", "landscape");
    pdf.setTextColor(...BRAND);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.text(report.company_name || "SUPER IQ-FOAM", pageWidth / 2, 12, { align: "center" });
    pdf.setTextColor(38, 43, 48);
    pdf.setFontSize(10);
    pdf.text(title, pageWidth / 2, 20, { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.text(`Date: ${report.date}`, 14, 29);

    const x = 14;
    const tableWidth = pageWidth - 28;
    const descriptionWidth = tableWidth * 0.78;
    let y = 35;
    pdf.setFillColor(...NAVY);
    pdf.rect(x, y, tableWidth, 7, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(6.5);
    pdf.text(descriptionLabel, x + 2, y + 4.5);
    pdf.text("AMOUNT", x + tableWidth - 2, y + 4.5, { align: "right" });
    y += 7;

    for (const item of items.slice(start, start + pageSize)) {
      const descriptionLines = pdf.splitTextToSize(
        String(item.description || item.client_name || "Fuel expense"),
        descriptionWidth - 4,
      );
      const rowHeight = Math.max(7, descriptionLines.length * 2.8 + 1);
      pdf.setDrawColor(...GRID);
      pdf.rect(x, y, descriptionWidth, rowHeight);
      pdf.rect(x + descriptionWidth, y, tableWidth - descriptionWidth, rowHeight);
      pdf.setTextColor(25, 33, 40);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(CELL_FONT_SIZE);
      pdf.text(descriptionLines, x + 2, y + 3.2, { lineHeightFactor: 1 });
      pdf.text(money(item.amount), x + tableWidth - 2, y + rowHeight * 0.65, { align: "right" });
      y += rowHeight;
    }
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

  drawAppendixPages(
    pdf,
    report,
    pageWidth,
    "PENDING INVOICES - NOT INCLUDED IN SENDING TOTAL",
    report.pending_invoices || [],
    "CLIENT / DESCRIPTION - NO INVOICE NUMBER",
  );
  const companyFileName = (report.company_name || "SUPERIQFOAM").replace(/[^a-z0-9]+/gi, "_");
  pdf.save(`${companyFileName}_Daily_Report_${report.date}.pdf`);
}

export async function downloadHomeReportPdf(report) {
  if (!report) throw new Error("Daily report data is not available.");
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const section = homeSection(report);
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 9;
  const top = 36;
  const sectionHeight = 78.5;
  const pages = paginateRows(pdf, section, pageWidth - margin * 2);

  pages.forEach((_, pageIndex) => {
    if (pageIndex > 0) pdf.addPage("a4", "landscape");
    pdf.setTextColor(...BRAND);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.text("HOME", pageWidth / 2, 10, { align: "center" });
    pdf.setTextColor(38, 43, 48);
    pdf.setFontSize(11);
    pdf.text(pageIndex ? "DAILY REPORT (CONTINUED)" : "DAILY REPORT", pageWidth / 2, 17, { align: "center" });
    pdf.setDrawColor(90, 96, 101);
    pdf.line(margin, 25, pageWidth - margin, 25);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.text(`Date: ${report.date}`, margin, 31);
    pdf.text(`Day: ${report.day || ""}`, pageWidth - margin, 31, { align: "right" });
    drawSection(pdf, section, pages, margin, top, pageWidth - margin * 2, sectionHeight, pageIndex);
  });

  pdf.save(`HOME_Daily_Report_${report.date}.pdf`);
}
