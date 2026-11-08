import test from "node:test";
import assert from "node:assert/strict";
import { isPieceworkTailor, moneyToCents, sumPayrollRows } from "./salaryReportMath.mjs";

test("payroll totals add each included employee row in integer cents", () => {
  const rows = [
    { grossCents: moneyToCents("6500.00"), cutCents: moneyToCents("1200.00"), netCents: moneyToCents("5300.00") },
    { grossCents: moneyToCents("916.50"), cutCents: moneyToCents("150.00"), netCents: moneyToCents("766.50") },
    { grossCents: moneyToCents("1000.00"), cutCents: moneyToCents("0.00"), netCents: moneyToCents("1000.00") },
  ];

  assert.deepEqual(sumPayrollRows(rows), {
    grossCents: 841650,
    cutCents: 135000,
    netCents: 706650,
  });
});

test("money conversion rounds decimal values without binary floating-point drift", () => {
  assert.equal(moneyToCents("1.005"), 101);
  assert.equal(moneyToCents("0.10"), 10);
  assert.equal(moneyToCents("-1.005"), -101);
  assert.equal(moneyToCents("invalid"), 0);
});

test("piece counts are shown only for Asive Tailor and Ayanda Tailor", () => {
  assert.equal(isPieceworkTailor({ name: "ASIVE TAILOR" }), true);
  assert.equal(isPieceworkTailor({ name: "  Ayanda   Tailor " }), true);
  assert.equal(isPieceworkTailor({ name: "Anele Fabric" }), false);
  assert.equal(isPieceworkTailor({ name: "AYANDA BHAI" }), false);
});

test("a report's totals equal exactly the rows selected for that report", () => {
  const reportRows = [
    { employee: "weekly", included: true, grossCents: 155000, cutCents: 0, netCents: 155000 },
    { employee: "monthly", included: false, grossCents: 1800000, cutCents: 0, netCents: 1800000 },
    { employee: "piecework", included: true, grossCents: 91650, cutCents: 15000, netCents: 76650 },
  ].filter((row) => row.included);
  const totals = sumPayrollRows(reportRows);

  assert.deepEqual(totals, {
    grossCents: reportRows.reduce((sum, row) => sum + row.grossCents, 0),
    cutCents: reportRows.reduce((sum, row) => sum + row.cutCents, 0),
    netCents: reportRows.reduce((sum, row) => sum + row.netCents, 0),
  });
  assert.equal(totals.netCents, totals.grossCents - totals.cutCents);
});
