import test from "node:test";
import assert from "node:assert/strict";
import { grvTotals, parseGrvDecimal, updateGrvReceivedQuantity } from "./grv.mjs";

test("accepted GRV quantity follows received quantity until changed manually", () => {
  const initial = {
    actual_received_quantity: 0,
    accepted_quantity: 0,
  };

  assert.deepEqual(updateGrvReceivedQuantity(initial, 10), {
    actual_received_quantity: 10,
    accepted_quantity: 10,
  });
  assert.deepEqual(updateGrvReceivedQuantity({
    actual_received_quantity: 10,
    accepted_quantity: 10,
  }, 8), {
    actual_received_quantity: 8,
    accepted_quantity: 8,
  });
});

test("changing received quantity preserves a manually adjusted accepted quantity", () => {
  assert.deepEqual(updateGrvReceivedQuantity({
    actual_received_quantity: 10,
    accepted_quantity: 7,
  }, 12), {
    actual_received_quantity: 12,
    accepted_quantity: 7,
  });
});

test("GRV decimal inputs accept comma and point separators", () => {
  assert.equal(parseGrvDecimal("12,75"), 12.75);
  assert.equal(parseGrvDecimal("12.75"), 12.75);
  assert.equal(parseGrvDecimal("1.234,56"), 1234.56);
});

test("GRV totals include custom VAT without changing line values", () => {
  assert.deepEqual(grvTotals([
    { accepted_quantity: 2, unit_cost: "10,25" },
    { accepted_quantity: 1, unit_cost: "5.50" },
  ], "15,5"), {
    subtotal: 26,
    vatAmount: 4.03,
    total: 30.03,
  });
});
