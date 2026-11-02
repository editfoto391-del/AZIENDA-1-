import test from "node:test";
import assert from "node:assert/strict";
import { updateGrvReceivedQuantity } from "./grv.mjs";

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
