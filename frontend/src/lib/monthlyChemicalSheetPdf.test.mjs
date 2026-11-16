import test from "node:test";
import assert from "node:assert/strict";
import { calculateMonthlySheet, createBlankMonthlySheet } from "./monthlyChemicalSheet.mjs";
import { createMonthlyChemicalSheetPdf } from "./monthlyChemicalSheetPdf.mjs";

test("monthly production and chemical balance export as a non-empty PDF", async () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "100";
  sheet.formula_rates.big_block.ppg = "2";
  sheet.weeks[0].big_block = { quantity: "3", weight_kg: "600" };
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
  assert.ok(pdfText.includes("ESTIMATED CHEMICAL CONTAINER USAGE"));
  assert.ok(pdfText.includes("GRV-001"));
});
