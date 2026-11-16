import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateMonthlySheet,
  createBlankMonthlySheet,
  MONTHLY_SHEET_CHEMICALS,
  monthlyWeekCount,
  monthlySheetPayload,
} from "./monthlyChemicalSheet.mjs";

test("monthly sheet chemical names are displayed in English", () => {
  assert.deepEqual(MONTHLY_SHEET_CHEMICALS.map(({ label }) => label), [
    "PPG (Polyol)",
    "TDI (Isocyanate)",
    "T-9 Catalyst",
    "Silicone",
    "Amine 52",
    "MCL",
  ]);
});

test("monthly sheet uses the selected month's Monday-based calendar weeks", () => {
  assert.equal(monthlyWeekCount("2026-02"), 5);
  assert.equal(monthlyWeekCount("2026-11"), 6);
});

test("monthly sheet sums arrivals and production across all month weeks", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  assert.equal(sheet.weeks.length, 6);
  sheet.arrivals.ppg = "100";
  sheet.arrivals.tdi = "50";
  sheet.weeks[0].big_block = { quantity: "2", weight_kg: "500" };
  sheet.weeks[1].big_block = { quantity: "1", weight_kg: "250" };
  sheet.weeks[5].big_block = { quantity: "2", weight_kg: "500" };

  const totals = calculateMonthlySheet(sheet);

  assert.equal(totals.totalArrivals, 150);
  assert.equal(totals.blockTotals.big_block.quantity, 5);
  assert.equal(totals.blockTotals.big_block.weight_kg, 1250);
  assert.equal(totals.totalBlocks, 5);
  assert.equal(totals.totalBlockWeight, 1250);
});

test("imported GRV arrivals are added to manual chemical arrivals", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "12";
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    lines: [
      { line_index: 0, chemical_key: "ppg", quantity_kg: 50 },
      { line_index: 1, chemical_key: "tdi", quantity_kg: 20 },
    ],
  });

  const totals = calculateMonthlySheet(sheet);
  const payload = monthlySheetPayload(sheet);

  assert.equal(totals.chemicalBalances.ppg.arrival, 62);
  assert.equal(totals.chemicalBalances.ppg.importedArrival, 50);
  assert.equal(totals.chemicalBalances.tdi.arrival, 20);
  assert.equal(totals.totalArrivals, 82);
  assert.deepEqual(payload.arrival_sources, [{
    grv_id: "grv-1",
    lines: [
      { line_index: 0, chemical_key: "ppg" },
      { line_index: 1, chemical_key: "tdi" },
    ],
  }]);
});

test("chemical balance is withheld when a produced block has no verified formula rate", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "100";
  sheet.weeks[0].big_blue_block = { quantity: "1", weight_kg: "100" };

  const balance = calculateMonthlySheet(sheet).chemicalBalances.ppg;

  assert.equal(balance.consumption, null);
  assert.equal(balance.remaining, null);
  assert.equal(balance.status, "missing-formula");
  assert.deepEqual(balance.missingRates, ["Big Blue Block"]);
});

test("verified per-block rates calculate consumption, remaining stock and reorder status", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "100";
  sheet.minimums.ppg = "50";
  sheet.formula_rates.big_block.ppg = "2.5";
  sheet.weeks[0].big_block = { quantity: "3", weight_kg: "750" };

  const balance = calculateMonthlySheet(sheet).chemicalBalances.ppg;

  assert.equal(balance.consumption, 7.5);
  assert.equal(balance.remaining, 92.5);
  assert.equal(balance.status, "ok");
});

test("GRV container estimate allocates weekly formula consumption in receipt order", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "50";
  sheet.weeks[1].big_block = { quantity: "1", weight_kg: "500" };
  sheet.weeks[2].big_block = { quantity: "1", weight_kg: "500" };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-02",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Drum",
      container_capacity: 100,
      container_count: 2,
      unit: "kg",
      quantity_kg: 200,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");

  assert.equal(tracking.containers[0].estimated_used_kg, 100);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 100);
  assert.equal(tracking.containers[0].empty_container_count, 1);
  assert.equal(tracking.containers[0].containers_with_stock, 1);
  assert.equal(tracking.containers[0].depletion_week, 3);
  assert.equal(tracking.untracked_consumption_kg, 0);
});

test("GRV container estimate waits for missing verified formula rates", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.weeks[0].big_block = { quantity: "1", weight_kg: "500" };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    received_date: "2026-11-01",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_capacity: 200,
      container_count: 2,
      unit: "kg",
      quantity_kg: 400,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");

  assert.deepEqual(tracking.missing_rates, ["Big Block"]);
  assert.equal(tracking.containers[0].status, "missing-formula");
  assert.equal(tracking.untracked_consumption_kg, null);
});

test("production before a container receipt is not allocated to that later GRV", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "100";
  sheet.weeks[1].big_block = { quantity: "1", weight_kg: "500" };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    received_date: "2026-11-10",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_capacity: 200,
      container_count: 2,
      unit: "kg",
      quantity_kg: 400,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");

  assert.equal(tracking.containers[0].estimated_used_kg, 0);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 400);
  assert.equal(tracking.untracked_consumption_kg, 100);
});

test("container estimates use the GRV's actual received quantity when it differs from capacity times count", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "200";
  sheet.weeks[0].big_block = { quantity: "1", weight_kg: "500" };
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
      quantity_kg: 300,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");

  assert.equal(tracking.containers[0].total_quantity_kg, 300);
  assert.equal(tracking.containers[0].estimated_used_kg, 200);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 100);
  assert.equal(tracking.containers[0].empty_container_count, 1);
  assert.equal(tracking.containers[0].containers_with_stock, 1);
});

test("sheet payload converts empty spreadsheet cells to null", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "12.5";
  sheet.weeks[0].small_block = { quantity: "4", weight_kg: "" };

  const payload = monthlySheetPayload(sheet);

  assert.equal(payload.arrivals.ppg, 12.5);
  assert.equal(payload.arrivals.tdi, null);
  assert.equal(payload.weeks[0].small_block.quantity, 4);
  assert.equal(payload.weeks[0].small_block.weight_kg, null);
  assert.equal(payload.weeks.length, 6);
});
