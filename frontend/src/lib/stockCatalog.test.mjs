import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateStockRows, uniqueStockCategories } from "./stockCatalog.mjs";

const aliases = {
  "Ribbon Black": ["Ribbon Black", "Ribbon Balck", "Black"],
  "Ribbon Pink": ["Ribbon Pink", "Ribbon"],
};

test("duplicate product and size rows keep the latest stock record", () => {
  const rows = deduplicateStockRows([
    { id: "old", product: " Simple ", size: "910x100", created_at: "2026-01-01", current: 4 },
    { id: "latest", product: "simple", size: " 910X100 ", created_at: "2026-02-01", current: 9 },
    { id: "other-size", product: "Simple", size: "910x120", created_at: "2026-01-01", current: 3 },
  ]);

  assert.deepEqual(rows.map(({ id }) => id), ["latest", "other-size"]);
  assert.equal(rows[0].product, "simple");
  assert.equal(rows[0].size, "910X100");
});

test("legacy product aliases collapse to their canonical category and size row", () => {
  const rows = deduplicateStockRows([
    { id: "legacy", product: "Ribbon Balck", size: "910x100", created_at: "2026-01-01" },
    { id: "canonical", product: " ribbon black ", size: "910x100", created_at: "2026-02-01" },
    { id: "pink", product: "Ribbon", size: "910x100", created_at: "2026-01-01" },
  ], aliases);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ product }) => product), ["Ribbon Black", "Ribbon Pink"]);
});

test("category filter list has one case-insensitive entry per category", () => {
  const categories = uniqueStockCategories([
    { product: "PRODUCT" },
    { product: "Product" },
    { product: "Product " },
    { product: "Ribbon Balck" },
    { product: "Black" },
  ], aliases);

  assert.deepEqual(categories, ["Product", "Ribbon Black"]);
});
