const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const MARGIN = 12;
const ROW_HEIGHT = 7;
const TABLE_TOP = 49;
const TABLE_HEADER_HEIGHT = 8;
const FOOTER_TOP = 198;
const ROWS_PER_PAGE = Math.floor(
  (FOOTER_TOP - TABLE_TOP - TABLE_HEADER_HEIGHT) / ROW_HEIGHT,
);
const NAVY = [16, 38, 62];
const TEXT = [30, 41, 59];
const MUTED = [100, 116, 139];
const BORDER = [203, 213, 225];

export const buildCustomerBalanceRows = (customers, balanceCentsByCustomer) => (
  customers
    .map((customer) => ({
      id: customer.id,
      name: customer.name || "Unnamed customer",
      balanceCents: balanceCentsByCustomer[customer.id] || 0,
    }))
    .filter((customer) => customer.balanceCents !== 0)
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)))
);

const formatBalance = (cents) => {
  const amount = Math.abs(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `-R ${amount}` : `R ${amount}`;
};

const fitText = (pdf, value, maxWidth) => {
  let text = String(value);
  if (pdf.getTextWidth(text) <= maxWidth) return text;
  while (text.length > 1 && pdf.getTextWidth(`${text}...`) > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
};

export const drawCustomerBalancePdf = (pdf, rows, { express, generatedDate }) => {
  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const totalCents = rows.reduce((total, row) => total + row.balanceCents, 0);
  const contentWidth = PAGE_WIDTH - MARGIN * 2;
  const numberWidth = 17;
  const balanceWidth = 54;
  const nameWidth = contentWidth - numberWidth - balanceWidth;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    if (pageIndex > 0) pdf.addPage("a4", "landscape");
    pdf.setFillColor(...NAVY);
    pdf.rect(MARGIN, 9, contentWidth, 25, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("SUPER IQ-FOAM", MARGIN + 5, 19);
    pdf.setFontSize(10);
    pdf.text("CLIENT BALANCE REPORT", MARGIN + 5, 27);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(express ? "Express Website" : "Clients", PAGE_WIDTH - MARGIN - 5, 20, { align: "right" });
    pdf.setFontSize(8);
    pdf.text(`Page ${pageIndex + 1} of ${pageCount}`, PAGE_WIDTH - MARGIN - 5, 27, { align: "right" });

    pdf.setTextColor(...MUTED);
    pdf.setFontSize(8);
    pdf.text(`Generated: ${generatedDate}`, MARGIN, 42);
    pdf.text(`Clients: ${rows.length}`, PAGE_WIDTH / 2, 42, { align: "center" });
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(...TEXT);
    pdf.text(`Total balance: ${formatBalance(totalCents)}`, PAGE_WIDTH - MARGIN, 42, { align: "right" });

    const tableHeaderY = TABLE_TOP;
    pdf.setFillColor(...NAVY);
    pdf.rect(MARGIN, tableHeaderY, contentWidth, TABLE_HEADER_HEIGHT, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.text("#", MARGIN + 3, tableHeaderY + 5.3);
    pdf.text("CLIENT NAME", MARGIN + numberWidth + 3, tableHeaderY + 5.3);
    pdf.text("BALANCE", PAGE_WIDTH - MARGIN - 3, tableHeaderY + 5.3, { align: "right" });

    const pageRows = rows.slice(pageIndex * ROWS_PER_PAGE, (pageIndex + 1) * ROWS_PER_PAGE);
    pageRows.forEach((row, rowIndex) => {
      const y = tableHeaderY + TABLE_HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
      const rowNumber = pageIndex * ROWS_PER_PAGE + rowIndex + 1;
      if (rowIndex % 2 === 1) {
        pdf.setFillColor(248, 250, 252);
        pdf.rect(MARGIN, y, contentWidth, ROW_HEIGHT, "F");
      }
      pdf.setDrawColor(...BORDER);
      pdf.setLineWidth(0.15);
      pdf.line(MARGIN, y + ROW_HEIGHT, PAGE_WIDTH - MARGIN, y + ROW_HEIGHT);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      pdf.setTextColor(...MUTED);
      pdf.text(String(rowNumber), MARGIN + 3, y + 4.8);
      pdf.setTextColor(...TEXT);
      pdf.text(fitText(pdf, row.name, nameWidth - 6), MARGIN + numberWidth + 3, y + 4.8);
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(...(row.balanceCents > 0 ? [185, 28, 28] : TEXT));
      pdf.text(formatBalance(row.balanceCents), PAGE_WIDTH - MARGIN - 3, y + 4.8, { align: "right" });
    });

    if (rows.length === 0) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(...MUTED);
      pdf.text("No clients to display.", MARGIN + 3, tableHeaderY + TABLE_HEADER_HEIGHT + 7);
    }

    pdf.setDrawColor(...BORDER);
    pdf.line(MARGIN, FOOTER_TOP, PAGE_WIDTH - MARGIN, FOOTER_TOP);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text("Confidential - for internal use", MARGIN, FOOTER_TOP + 5);
    pdf.text("SUPER IQ-FOAM", PAGE_WIDTH - MARGIN, FOOTER_TOP + 5, { align: "right" });
  }
};

export async function downloadCustomerBalancePdf(customers, balanceCentsByCustomer, { express, generatedDate }) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const rows = buildCustomerBalanceRows(customers, balanceCentsByCustomer);
  drawCustomerBalancePdf(pdf, rows, { express, generatedDate });
  const section = express ? "Express" : "Clients";
  pdf.save(`SUPER_IQ_FOAM_${section}_Balances_${generatedDate}.pdf`);
}