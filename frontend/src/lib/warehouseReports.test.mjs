import test from "node:test";
import assert from "node:assert/strict";
import {
  warehouseReportDetails,
  warehouseReportMetrics,
  warehouseReportTotalsForDate,
} from "./warehouseReports.mjs";

const metric = (warehouseId, report, label) => warehouseReportMetrics(warehouseId, report)
  .find((item) => item.label === label)?.value;

test("Warehouse A report summary totals output by categories and preserves size and type breakdowns", () => {
  const report = {
    chemicals: [
      { chemical: "Polyol", unit: "L", quantity: 12 },
      { chemical: "Polyol", unit: "L", quantity: 8 },
      { chemical: "Catalyst", unit: "kg", quantity: 2 },
    ],
    manufactured_blocks: [
      { block_type: "White", size: "Large", quantity: 5 },
      { block_type: "White", size: "Large", quantity: 3 },
      { block_type: "Blue", size: "Small", quantity: 2 },
    ],
    foam_cut: [{ size: "50mm", unit: "m3", quantity: 4 }],
    damaged_blocks: [{ block_type: "White", size: "Large", quantity: 1 }],
    sheets_cut: [{ size: "1000x2000", quantity: 12 }],
  };

  assert.equal(metric("A", report, "Total chemical usage"), "Polyol (L): 20 · Catalyst (kg): 2");
  assert.equal(metric("A", report, "Total blocks manufactured"), "10 blocks");
  assert.equal(metric("A", report, "Manufactured by type and size"), "White · Large: 8 · Blue · Small: 2");
  assert.equal(metric("A", report, "Total foam cut"), "50mm m3: 4");
  assert.equal(metric("A", report, "Total damaged and broken blocks"), "1 block");
  assert.equal(metric("A", report, "Total sheets cut"), "12 sheets");
});

test("warehouse report totals include saved reports for the selected date and current entries", () => {
  const totals = warehouseReportTotalsForDate(
    "2026-11-02",
    {
      date: "2026-11-02",
      chemicals: [{ chemical: "", unit: "", quantity: "" }],
      manufactured_blocks: [],
    },
    [
      {
        date: "2026-11-02",
        chemicals: [{ chemical: "Polyol", unit: "L", quantity: 20 }],
        manufactured_blocks: [{ block_type: "White", size: "Large", quantity: 8 }],
      },
      {
        date: "2026-11-01",
        chemicals: [{ chemical: "Polyol", unit: "L", quantity: 100 }],
        manufactured_blocks: [{ block_type: "White", size: "Large", quantity: 50 }],
      },
    ],
  );

  assert.equal(metric("A", totals, "Total chemical usage"), "Polyol (L): 20");
  assert.equal(metric("A", totals, "Total blocks manufactured"), "8 blocks");
  assert.equal(metric("A", totals, "Manufactured by type and size"), "White · Large: 8");
});

test("Warehouse B report summary totals received mattresses and completed bundles", () => {
  const report = {
    foam_received: [
      { unit: "m3", quantity: 10 },
      { unit: "m3", quantity: 5 },
      { unit: "blocks", quantity: 2 },
    ],
    mattresses_received: [
      { size: "Single", quantity: 8 },
      { size: "Double", quantity: 4 },
    ],
    mattresses_completed: [
      { size: "Single", quantity: 7 },
      { size: "Double", quantity: 3 },
    ],
  };

  assert.equal(metric("B", report, "Total foam received"), "m3: 15 · blocks: 2");
  assert.equal(metric("B", report, "Total mattresses received"), "12 pcs");
  assert.equal(metric("B", report, "Total bundles made"), "10 bundles");
  assert.equal(metric("B", report, "Bundles made by size"), "Single: 7 · Double: 3");
});

test("Warehouse C report summary totals stock, ordered and loaded pieces by invoice", () => {
  const report = {
    completed_stock: [
      { size: "Single", quantity: 20 },
      { size: "Double", quantity: 12 },
    ],
    dispatches: [
      { customer_name: "Customer One", invoice_number: "INV-1", size: "Single", ordered_quantity: 5, loaded_quantity: 5 },
      { customer_name: "Customer One", invoice_number: "INV-1", size: "Double", ordered_quantity: 3, loaded_quantity: 2 },
      { customer_name: "Customer Two", invoice_number: "INV-2", size: "Single", ordered_quantity: 4, loaded_quantity: 4 },
    ],
  };

  assert.equal(metric("C", report, "Total completed stock added"), "32 pcs");
  assert.equal(metric("C", report, "Total quantity ordered"), "12 pcs");
  assert.equal(metric("C", report, "Total pieces loaded and dispatched"), "11 pcs");
  assert.equal(metric("C", report, "Customer invoices dispatched"), "2");
});

test("shared report details expose the saved rows and all PDF table columns", () => {
  const sections = warehouseReportDetails("C", {
    completed_stock: [{ size: "Single", quantity: 20 }],
    dispatches: [{
      customer_name: "Customer One",
      invoice_number: "INV-1",
      size: "Single",
      ordered_quantity: 5,
      loaded_quantity: 4,
    }],
  });

  assert.equal(sections.length, 2);
  assert.deepEqual(sections[1].fields.map(([, label]) => label), [
    "Customer", "Invoice", "Size", "Ordered", "Loaded",
  ]);
  assert.equal(sections[1].rows[0].loaded_quantity, 4);
});
