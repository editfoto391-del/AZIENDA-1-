export const drawStockRangeReportPdf = (pdf, sections, { blank, getQuantity }) => {
  const pageWidth = 297;
  const margin = 10;
  const gap = 6;
  const columnWidth = (pageWidth - margin * 2 - gap) / 2;
  const navy = [16, 38, 62];
  const drawHeader = (pageNumber) => {
    pdf.setFillColor(...navy);
    pdf.rect(margin, 9, pageWidth - margin * 2, 23, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(20);
    pdf.text("SUPER IQ-FOAM", margin + 5, 19);
    pdf.setFontSize(8);
    pdf.text("QUALITY  |  COMFORT  |  TRUST", margin + 5, 25);
    pdf.setFontSize(13);
    pdf.text(`PRODUCT RANGE REPORT - PAGE ${pageNumber} OF 2`, pageWidth - margin - 5, 21, { align: "right" });
    pdf.setTextColor(15, 23, 42);
    pdf.setFontSize(8);
    const metaY = 40;
    ["DATE:", "PREPARED BY:", "WAREHOUSE:"].forEach((label, index) => {
      const x = margin + index * ((pageWidth - margin * 2) / 3);
      pdf.setFont("helvetica", "bold");
      pdf.text(label, x, metaY);
      const labelWidth = pdf.getTextWidth(label);
      const fieldEnd = x + (pageWidth - margin * 2) / 3 - 7;
      pdf.setDrawColor(100, 116, 139);
      pdf.line(x + labelWidth + 2, metaY + 1, fieldEnd, metaY + 1);
    });
  };
  const drawSection = (section, x, y, width, rowHeight = 5.2) => {
    const titleHeight = 7;
    const tableHeaderHeight = 6;
    const numberWidth = width * 0.1;
    const sizeWidth = width * 0.24;
    const typeWidth = width * 0.38;
    const columns = [
      { label: "#", width: numberWidth },
      { label: "SIZE (mm)", width: sizeWidth },
      { label: section.columns[2], width: typeWidth },
      { label: "QTY / STOCK", width: width - numberWidth - sizeWidth - typeWidth },
    ];
    pdf.setFillColor(...navy);
    pdf.rect(x, y, width, titleHeight, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.text(section.title, x + 2, y + 4.8);
    let currentY = y + titleHeight;
    let currentX = x;
    pdf.setFillColor(226, 232, 240);
    pdf.setDrawColor(148, 163, 184);
    pdf.setFontSize(7);
    columns.forEach((column) => {
      pdf.rect(currentX, currentY, column.width, tableHeaderHeight, "FD");
      pdf.setTextColor(15, 23, 42);
      pdf.text(column.label, currentX + column.width / 2, currentY + 4, { align: "center" });
      currentX += column.width;
    });
    currentY += tableHeaderHeight;
    section.rows.forEach((row) => {
      currentX = x;
      const values = [String(row.number), row.size.replace("x", " X "), row.type, blank ? "" : getQuantity(row.group, row.size)];
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(15, 23, 42);
      columns.forEach((column, index) => {
        pdf.rect(currentX, currentY, column.width, rowHeight);
        pdf.text(values[index], currentX + column.width / 2, currentY + rowHeight * 0.68, { align: "center" });
        currentX += column.width;
      });
      currentY += rowHeight;
    });
  };
  const sectionsByTitle = new Map(sections.map((section) => [section.title, section]));
  drawHeader(1);
  drawSection(sectionsByTitle.get("MIX-COLOR RANGE"), margin, 46, columnWidth);
  drawSection(sectionsByTitle.get("RIBBON RANGE"), margin + columnWidth + gap, 46, columnWidth);

  pdf.addPage("a4", "landscape");
  drawHeader(2);
  drawSection(sectionsByTitle.get("CANDY RANGE"), margin, 46, pageWidth - margin * 2, 5.2);
  drawSection(sectionsByTitle.get("STRONG BOY RANGE"), margin, 132, columnWidth);
  drawSection(sectionsByTitle.get("UNCOVERED RANGE"), margin + columnWidth + gap, 132, columnWidth);
  const footerY = 177;
  pdf.setFillColor(...navy);
  pdf.rect(margin, footerY, 165, 18, "F");
  pdf.rect(margin + 171, footerY, 106, 18, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text("NOTES / REMARKS:", margin + 3, footerY + 5);
  pdf.text("SIGNATURE:", margin + 174, footerY + 5);
  pdf.setDrawColor(255, 255, 255);
  pdf.line(margin + 174, footerY + 15, pageWidth - margin - 3, footerY + 15);
};
