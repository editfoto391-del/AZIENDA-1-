import assert from "node:assert/strict";
import test from "node:test";
import {
  correctCommonExpenseTypos,
  filterExpenseRows,
  sumExpenseRows,
} from "./expensesMath.mjs";

test("corrects known expense misspellings without rewriting uncertain names", () => {
  assert.equal(correctCommonExpenseTypos("VEICHLE DEISEL COMMISION"), "VEHICLE DIESEL COMMISSION");
  assert.equal(correctCommonExpenseTypos("Chinba Mall"), "Chinba Mall");
  assert.equal(correctCommonExpenseTypos("Commissioning"), "Commissioning");
});

test("filters recorded expenses and completed fleet costs on the same date and search rules", () => {
  const rows = filterExpenseRows(
    [{ id: "expense", date: "2026-11-18", category: "Diesel", description: "Fuel", amount: "12.50" }],
    [
      { id: "fleet-1", date: "2026-11-19", category: "Vehicle Repair", description: "Repair", amount: 25, source: "fleet" },
      { id: "other", date: "2026-11-19", category: "Materials", description: "Stock", amount: 50, source: "expense" },
    ],
    { month: "2026-11" },
    "2026-11-20",
  );
  assert.deepEqual(rows.map((row) => row.id), ["fleet-1", "expense"]);
  assert.equal(rows[0].source, "vehicle_record");
  assert.equal(sumExpenseRows(rows), 37.5);
});

test("current-month totals exclude future-dated entries and city-filtered views exclude fleet costs", () => {
  const rows = filterExpenseRows(
    [
      { id: "today", date: "2026-11-20", category: "Diesel", destination_city: "Durban", description: "Fuel", amount: 10 },
      { id: "future", date: "2026-11-21", category: "Diesel", destination_city: "Durban", description: "Fuel", amount: 20 },
    ],
    [{ id: "fleet", date: "2026-11-20", category: "Vehicle Repair", description: "Repair", amount: 30, source: "fleet" }],
    { month: "2026-11", destinationCity: "Durban" },
    "2026-11-20",
  );
  assert.deepEqual(rows.map((row) => row.id), ["today"]);
  assert.equal(sumExpenseRows(rows), 10);
});

test("filtered money totals add currency values in cents", () => {
  assert.equal(sumExpenseRows([{ amount: "0.10" }, { amount: 0.2 }]), 0.3);
});

test("filtered total counts duplicate expense IDs only once", () => {
  const rows = filterExpenseRows(
    [
      { id: "duplicate", date: "2026-11-18", category: "General", description: "Fuel", amount: 10 },
      { id: "duplicate", date: "2026-11-18", category: "General", description: "Fuel", amount: 10 },
    ],
    [],
    {},
    "2026-11-20",
  );
  assert.equal(sumExpenseRows(rows), 10);
});
