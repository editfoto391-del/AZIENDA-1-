import assert from "node:assert/strict";
import test from "node:test";
import { jsPDF } from "jspdf";
import { buildCustomerBalanceRows, drawCustomerBalancePdf } from "./customerBalancePdf.mjs";

test("customer balance rows exclude zero balances and sort remaining clients alphabetically", () => {
  const rows = buildCustomerBalanceRows([
    { id: "c2", name: "Zeta" },
    { id: "c1", name: "Alpha" },
    { id: "c3", name: "Middle" },
    { id: "c4", name: "Negative balance" },
  ], { c2: 12500, c1: 0, c4: -500 });

  assert.deepEqual(rows.map(({ name, balanceCents }) => [name, balanceCents]), [
    ["Negative balance", -500],
    ["Zeta", 12500],
  ]);
});

test("customer balance PDF contains one complete client list and a report total", () => {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const rows = buildCustomerBalanceRows([
    { id: "c1", name: "Alpha Client" },
    { id: "c2", name: "Beta Client" },
  ], { c1: 12500, c2: 2500 });

  drawCustomerBalancePdf(pdf, rows, { express: true, generatedDate: "13 Nov 2026" });

  assert.equal(pdf.getNumberOfPages(), 1);
  const content = pdf.output();
  for (const text of [
    "SUPER IQ-FOAM",
    "CLIENT BALANCE REPORT",
    "Express Website",
    "Alpha Client",
    "Beta Client",
    "R 125.00",
    "R 25.00",
    "Total balance: R 150.00",
  ]) {
    assert.ok(content.includes(text), `Expected PDF to contain "${text}"`);
  }
});

test("customer balance PDF paginates large client lists without dropping rows", () => {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: `c${index}`,
    name: `Client ${index + 1}`,
    balanceCents: 0,
  }));

  drawCustomerBalancePdf(pdf, rows, { express: false, generatedDate: "13 Nov 2026" });

  assert.ok(pdf.getNumberOfPages() > 1);
  const content = pdf.output();
  assert.ok(content.includes("Client 1"));
  assert.ok(content.includes("Client 50"));
  assert.ok(content.includes(`Page 1 of ${pdf.getNumberOfPages()}`));
});