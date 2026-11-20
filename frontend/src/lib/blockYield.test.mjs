import assert from "node:assert/strict";
import test from "node:test";
import { assessBlockYield, expectedWhiteBlockYield } from "./blockYield.mjs";

test("Big Block White has the configured expected yield for each supported size", () => {
  assert.equal(expectedWhiteBlockYield("White", "910x100"), 39);
  assert.equal(expectedWhiteBlockYield("White", "1070x100"), 26);
  assert.equal(expectedWhiteBlockYield("White", "1070x120"), 22);
  assert.equal(expectedWhiteBlockYield("White", "760x100"), 39);
  assert.equal(expectedWhiteBlockYield("White", "910 × 100"), 39);
  assert.equal(expectedWhiteBlockYield("Black", "910x100"), null);
  assert.equal(expectedWhiteBlockYield("White", "910x120"), null);
});

test("yield assessment flags missing pieces only below the expected count", () => {
  assert.deepEqual(assessBlockYield("White", "910x100", 32), {
    expectedPieces: 39,
    actualPieces: 32,
    missingPieces: 7,
    lossAlert: true,
  });
  assert.equal(assessBlockYield("White", "910x100", 39).lossAlert, false);
  assert.equal(assessBlockYield("White", "910x100", 42).missingPieces, 0);
});