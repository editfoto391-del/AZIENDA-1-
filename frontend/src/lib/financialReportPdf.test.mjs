import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinancialReportPdfData } from "./financialReportPdf.js";

test("financial report PDF data uses the selected company's actual period totals", () => {
  const data = buildFinancialReportPdfData({
    company_name: "SUPER IQ-FOAM",
    period: "monthly",
    start: "2026-10-01",
    end: "2026-10-31",
    generated_at: "2026-11-01T10:00:00Z",
    summary: {
      total_invoices: 1000,
      payments_received: 600,
      pending_payments: 750,
      expenses: 300,
      buyings: 50,
      salaries: 100,
      grv: 25,
      final_profit: 125,
    },
    transactions: {
      expenses: [
        { category: "Diesel", amount: 80 },
        { category: "Rent", amount: 220 },
      ],
    },
    diesel_usage: [{ vehicle: "Hino 500", records: 2, amount: 80 }],
    accounting_notes: ["Actual report note"],
  });

  assert.equal(data.title, "Monthly Performance Report — October 2026");
  assert.equal(data.metrics[2].value, "R 750,00");
  assert.equal(data.metrics[4].value, "R 125,00");
  assert.equal(data.metrics[5].value, "12,5%");
  assert.deepEqual(data.expenses, [
    { category: "Diesel", amount: 80 },
    { category: "Rent", amount: 220 },
  ]);
  assert.deepEqual(data.diesel, [{ vehicle: "Hino 500", records: 2, amount: 80 }]);
  assert.equal(data.overview.at(-1).amount, 125);
});

test("financial report PDF rejects missing report data instead of creating empty totals", () => {
  assert.throws(() => buildFinancialReportPdfData(null), /data is not available/);
});
