import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDailyProductionReport,
  calculateMonthlySheet,
  createBlankMonthlySheet,
  monthlyProductionDays,
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

test("daily production dates are grouped into the selected month's Monday-based weeks", () => {
  const days = monthlyProductionDays("2026-11");

  assert.equal(days.length, 30);
  assert.equal(days[0].date, "2026-11-01");
  assert.equal(days[0].week_index, 0);
  assert.equal(days[1].date, "2026-11-02");
  assert.equal(days[1].week_index, 1);
  assert.equal(days[30 - 1].date, "2026-11-30");
  assert.equal(days[30 - 1].week_index, 5);
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

test("daily production drives monthly and weekly totals while untouched weeks retain legacy totals", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.weeks[1].big_block = { quantity: "9", weight_kg: "4500" };
  sheet.weeks[2].small_block = { quantity: "3", weight_kg: "450" };
  const dailyBigBlock = sheet.production_days.find(({ date }) => date === "2026-11-02");
  dailyBigBlock.big_block = { quantity: "2", weight_kg: "1000" };
  const dailySmallBlock = sheet.production_days.find(({ date }) => date === "2026-11-04");
  dailySmallBlock.small_block = { quantity: "4", weight_kg: "600" };

  const totals = calculateMonthlySheet(sheet);

  assert.equal(totals.productionByWeek[1].big_block.quantity, 2);
  assert.equal(totals.productionByWeek[1].small_block.quantity, 4);
  assert.equal(totals.blockTotals.big_block.quantity, 2);
  assert.equal(totals.blockTotals.small_block.quantity, 7);
  assert.equal(totals.blockTotals.small_block.weight_kg, 1050);
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

test("chemical balance requests re-order at the minimum threshold", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "1000";
  sheet.minimums.ppg = "200";
  sheet.formula_rates.big_block.ppg = "200";
  sheet.weeks[0].big_block = { quantity: "4", weight_kg: "2000" };

  const balance = calculateMonthlySheet(sheet).chemicalBalances.ppg;

  assert.equal(balance.remaining, 200);
  assert.equal(balance.status, "reorder");
});

test("chemical balance is FINISHED at zero and below", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "200";
  sheet.minimums.ppg = "200";
  sheet.formula_rates.big_block.ppg = "200";
  sheet.weeks[0].big_block = { quantity: "1", weight_kg: "500" };

  const atZero = calculateMonthlySheet(sheet).chemicalBalances.ppg;
  assert.equal(atZero.remaining, 0);
  assert.equal(atZero.status, "finished");

  sheet.weeks[0].big_block.quantity = "2";
  const belowZero = calculateMonthlySheet(sheet).chemicalBalances.ppg;
  assert.equal(belowZero.remaining, -200);
  assert.equal(belowZero.status, "finished");
});

test("GRV container usage allocates production formula consumption in receipt order", () => {
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

  assert.equal(tracking.containers[0].actually_used_kg, 100);
  assert.equal(tracking.containers[0].usage_by_block.big_block, 100);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 100);
  assert.equal(tracking.containers[0].empty_container_count, 1);
  assert.equal(tracking.containers[0].containers_with_stock, 1);
  assert.equal(tracking.containers[0].depletion_week, null);
  assert.equal(tracking.untracked_consumption_kg, 0);
});

test("GRV container actual usage waits for missing verified formula rates", () => {
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

test("monthly production is matched to the month's GRVs without relying on exact receipt day", () => {
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

  assert.equal(tracking.containers[0].actually_used_kg, 100);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 300);
  assert.equal(tracking.untracked_consumption_kg, 0);
});

test("one big block using 2000 kg empties ten 200 kg PPG barrels", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "2000";
  sheet.weeks[1].big_block = { quantity: "1", weight_kg: "500" };
  sheet.arrival_sources.push({
    grv_id: "grv-ppg-10-barrels",
    grv_number: "GRV-PPG-10",
    received_date: "2026-11-16",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Barrel",
      container_capacity: 200,
      container_count: 10,
      unit: "kg",
      quantity_kg: 2000,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");

  assert.equal(tracking.usage_by_block.find(({ block_key }) => block_key === "big_block").used_kg, 2000);
  assert.equal(tracking.containers[0].actually_used_kg, 2000);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 0);
  assert.equal(tracking.containers[0].empty_container_count, 10);
  assert.equal(tracking.containers[0].containers_with_stock, 0);
  assert.equal(tracking.tracked_remaining_kg, 0);
  assert.equal(tracking.untracked_consumption_kg, 0);
});

test("daily production report totals block and chemical use and only counts receipts through report date", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "200";
  sheet.formula_rates.small_block.ppg = "50";
  sheet.arrivals.ppg = "100";
  sheet.production_days.find(({ date }) => date === "2026-11-16").big_block = {
    quantity: "1",
    weight_kg: "500",
  };
  sheet.production_days.find(({ date }) => date === "2026-11-15").small_block = {
    quantity: "1",
    weight_kg: "150",
  };
  sheet.weeks[2].big_block = { quantity: "99", weight_kg: "49500" };
  sheet.arrival_sources.push(
    {
      grv_id: "grv-before",
      grv_number: "GRV-BEFORE",
      received_date: "2026-11-10",
      lines: [{
        line_index: 0,
        chemical_key: "ppg",
        container_type: "Barrel",
        container_capacity: 200,
        container_count: 2,
        unit: "kg",
        quantity_kg: 400,
      }],
    },
    {
      grv_id: "grv-after",
      grv_number: "GRV-AFTER",
      received_date: "2026-11-20",
      lines: [{
        line_index: 0,
        chemical_key: "ppg",
        container_type: "Barrel",
        container_capacity: 200,
        container_count: 10,
        unit: "kg",
        quantity_kg: 2000,
      }],
    },
  );

  const report = calculateDailyProductionReport(sheet, "2026-11-16");
  const ppg = report.balances.find(({ key }) => key === "ppg");

  assert.equal(report.totalBlocks, 1);
  assert.equal(report.totalWeightKg, 500);
  assert.equal(report.chemicalUsage.find(({ key }) => key === "ppg").used_today_kg, 200);
  assert.equal(ppg.used_today_kg, 200);
  assert.equal(ppg.remaining_kg, 250);
  assert.equal(ppg.barrels_remaining, 1);
  assert.equal(ppg.tracked_remaining_kg, 150);
});

test("daily production report withholds chemical use and barrel counts when formula or GRV data is incomplete", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.production_days.find(({ date }) => date === "2026-11-16").big_block.quantity = "1";
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-01",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Barrel",
      container_capacity: 200,
      container_count: 2,
      unit: "kg",
      quantity_kg: 300,
    }],
  });

  const report = calculateDailyProductionReport(sheet, "2026-11-16");
  const ppg = report.balances.find(({ key }) => key === "ppg");

  assert.equal(report.chemicalUsage.find(({ key }) => key === "ppg").used_today_kg, null);
  assert.equal(ppg.remaining_kg, null);
  assert.equal(ppg.barrels_remaining, null);
  assert.equal(ppg.hasContainerMismatch, true);
  assert.equal(calculateDailyProductionReport(sheet, "2026-10-16"), null);
});

test("container usage uses GRV received kg and flags inconsistent container counts", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "100";
  sheet.weeks[1].big_block = { quantity: "2", weight_kg: "1000" };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-02",
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
  assert.equal(tracking.containers[0].actually_used_kg, 200);
  assert.equal(tracking.containers[0].remaining_quantity_kg, 100);
  assert.equal(tracking.containers[0].empty_container_count, null);
  assert.equal(tracking.containers[0].status, "container-data-mismatch");
  assert.equal(tracking.tracked_remaining_kg, 100);
});

test("actual chemical usage shows production blocks and their verified formulas", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.formula_rates.big_block.ppg = "10";
  sheet.formula_rates.small_block.ppg = "4";
  sheet.weeks[1].big_block = { quantity: "2", weight_kg: "1000" };
  sheet.weeks[1].small_block = { quantity: "3", weight_kg: "450" };
  sheet.arrival_sources.push({
    grv_id: "grv-1",
    grv_number: "GRV-001",
    received_date: "2026-11-02",
    lines: [{
      line_index: 0,
      chemical_key: "ppg",
      container_type: "Drum",
      container_capacity: 25,
      container_count: 1,
      unit: "kg",
      quantity_kg: 25,
    }],
  });

  const tracking = calculateMonthlySheet(sheet).containerTracking
    .find(({ chemical_key }) => chemical_key === "ppg");
  const bigBlockUsage = tracking.usage_by_block.find(({ block_key }) => block_key === "big_block");
  const smallBlockUsage = tracking.usage_by_block.find(({ block_key }) => block_key === "small_block");

  assert.deepEqual(bigBlockUsage, {
    block_key: "big_block",
    block_label: "Big Block",
    blocks_produced: 2,
    formula_rate_kg_per_block: 10,
    used_kg: 20,
    formula_missing: false,
  });
  assert.deepEqual(smallBlockUsage, {
    block_key: "small_block",
    block_label: "Small Block",
    blocks_produced: 3,
    formula_rate_kg_per_block: 4,
    used_kg: 12,
    formula_missing: false,
  });
  assert.equal(tracking.containers[0].actually_used_kg, 25);
  assert.equal(tracking.containers[0].usage_by_block.big_block, 20);
  assert.equal(tracking.containers[0].usage_by_block.small_block, 5);
  assert.equal(tracking.untracked_consumption_kg, 7);
});

test("sheet payload converts empty spreadsheet cells to null", () => {
  const sheet = createBlankMonthlySheet("2026-11");
  sheet.arrivals.ppg = "12.5";
  sheet.weeks[0].small_block = { quantity: "4", weight_kg: "" };
  sheet.production_days.find(({ date }) => date === "2026-11-03").big_block = {
    quantity: "2",
    weight_kg: "1000",
  };

  const payload = monthlySheetPayload(sheet);

  assert.equal(payload.arrivals.ppg, 12.5);
  assert.equal(payload.arrivals.tdi, null);
  assert.equal(payload.weeks[0].small_block.quantity, 4);
  assert.equal(payload.weeks[0].small_block.weight_kg, null);
  assert.equal(payload.weeks.length, 6);
  assert.equal(payload.production_days.length, 30);
  assert.deepEqual(payload.production_days[2], {
    date: "2026-11-03",
    big_block: { quantity: 2, weight_kg: 1000 },
    big_blue_block: { quantity: null, weight_kg: null },
    medium_block: { quantity: null, weight_kg: null },
    small_block: { quantity: null, weight_kg: null },
    small_blue_block: { quantity: null, weight_kg: null },
  });
});
