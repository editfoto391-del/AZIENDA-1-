import test from "node:test";
import assert from "node:assert/strict";
import { calculateMonthlySheet, createBlankMonthlySheet } from "./monthlyChemicalSheet.mjs";
import {
  createDailyChemicalAndBlockPdf,
  createMonthlyChemicalSheetPdf,
} from "./monthlyChemicalSheetPdf.mjs";
import { calculateDailyProductionReport } from "./monthlyChemicalSheet.mjs";

test("monthly production and chemical balance export as a non-empty PDF", async () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "100";
  sheet.minimums.ppg = "600";
  sheet.formula_rates.big_block.ppg = "2";
  sheet.production_days.find(({ date }) => date === "2026-11-01").big_block = {
    quantity: "3",
    weight_kg: "600",
  };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-01",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Drum",
      container_capacity: 200,
      container_count: 2,
      unit: "kg",
      quantity_kg: 400,
    }],
  });
  const pdf = await createMonthlyChemicalSheetPdf(sheet, calculateMonthlySheet(sheet));
  const output = pdf.output("arraybuffer");
  const pdfText = pdf.output();

  assert.ok(pdf.internal.getNumberOfPages() >= 2);
  assert.ok(output.byteLength > 1000);
  assert.ok(pdfText.includes("ACTUAL CHEMICAL USE BY PRODUCTION BLOCK"));
  assert.ok(pdfText.includes("Actually used \\(kg\\)"));
  assert.ok(pdfText.includes("CHEMICAL AND CONTAINER BALANCE"));
  assert.ok(pdfText.includes("DAILY PRODUCTION"));
  assert.ok(pdfText.includes("2026-11-01"));
  assert.ok(pdfText.includes("GRV-001"));
  assert.ok(pdfText.includes("RE-ORDER AS SOON AS POSSIBLE"));
});

test("daily production and chemical balance export as a non-empty PDF", async () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "400";
  sheet.formula_rates.big_block.ppg = "200";
  sheet.production_days.find(({ date }) => date === "2026-11-01").big_block = {
    quantity: "1",
    weight_kg: "2000",
  };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-01",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Drum",
      container_capacity: 200,
      container_count: 2,
      unit: "kg",
      quantity_kg: 400,
    }],
  });

  const report = calculateDailyProductionReport(sheet, "2026-11-01");
  const pdf = await createDailyChemicalAndBlockPdf(report);
  const output = pdf.output("arraybuffer");
  const pdfText = pdf.output();

  assert.ok(output.byteLength > 1000);
  assert.ok(pdfText.includes("DAILY CHEMICAL & BLOCK REPORT"));
  assert.ok(pdfText.includes("2026-11-01"));
  assert.ok(pdfText.includes("BLOCKS PRODUCED"));
  assert.ok(pdfText.includes("CHEMICAL USED TODAY"));
  assert.ok(pdfText.includes("CHEMICAL BALANCE AT END OF DAY"));
  assert.ok(pdfText.includes("FORMULA NEEDED"));
});
