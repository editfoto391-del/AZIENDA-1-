import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalInvoiceSize,
  canonicalInvoiceCategory,
  invoiceCategoriesFor,
  invoicePriceCategory,
  invoiceSizesFor,
  isManualInvoicePrice,
  lookupInvoicePrice,
  resolveInvoiceLineForIssue,
  sameInvoicePriceCategory,
} from "./invoicePricing.mjs";

const unifiedPrices = [
  { zone: 1, category: "Simple", size: "760x50", price: 105, active: true, confirmed: true },
  { zone: 1, category: "Ribbon Black", size: "760x100", price: 217, active: true, confirmed: true },
  { zone: 1, category: "Ribbon Pink", size: "760x100", price: null, active: true, confirmed: false },
];

test("known aliases and case variations use canonical category labels", () => {
  for (const alias of ["Black", "black fabric", "Fabric Black", "Ribbon Balck", "Ribbon Black Fabric"]) {
    assert.equal(canonicalInvoiceCategory(alias), "Ribbon Black");
    assert.equal(invoicePriceCategory(alias, true), "Ribbon Black");
  }
  assert.equal(canonicalInvoiceCategory("Ribbon"), "Ribbon Pink");
  assert.equal(invoicePriceCategory(" ribbon ", true), "Ribbon Pink");
  assert.equal(invoicePriceCategory(" cAnDy ", true), "Ribbon Black");
  assert.equal(invoicePriceCategory(" SIMPLE/MIX COLOR ", true), "Simple");
  assert.equal(invoicePriceCategory(" simple ", false), "Standard");
  assert.equal(canonicalInvoiceCategory("Uncovered Blue 16 Density"), "Uncovered Blue 16 Density");
});

test("numeric dimension formats match while other size labels remain literal", () => {
  assert.equal(canonicalInvoiceSize("910 × 100"), "910x100");
  assert.equal(canonicalInvoiceSize("910 X 100"), "910x100");
  assert.equal(canonicalInvoiceSize("910 x 100 x 50"), "910x100x50");
  assert.equal(canonicalInvoiceSize("Unit"), "Unit");
  assert.equal(canonicalInvoiceSize("910/100"), "910/100");
});

test("category and size lists include canonical aliases without crossing zones", () => {
  const prices = [
    { ...unifiedPrices[1], category: "Black fabric" },
    { ...unifiedPrices[0], zone: 2, size: "910x100" },
  ];
  const categories = invoiceCategoriesFor(1, true, prices, [
    { product: "Ribbon Balck", size: "910x100" },
  ]);
  assert.equal(categories.filter((category) => category === "Ribbon Black").length, 1);
  assert.ok(!categories.includes("Black fabric"));
  assert.deepEqual(invoiceSizesFor(1, "Ribbon Black", true, prices, []), ["760x100"]);
  assert.deepEqual(invoiceSizesFor(2, "Simple/Mix color", true, prices, []), ["910x100"]);
});

test("price lookup prioritizes canonical rows and resolves shared legacy aliases", () => {
  const legacy = { ...unifiedPrices[1], category: "Black fabric", price: 220 };
  assert.deepEqual(lookupInvoicePrice(1, "Black", "760x100", true, [legacy]), {
    price: 220,
    needsConfig: false,
  });
  assert.deepEqual(lookupInvoicePrice(1, "Candy", "760x100", true, [legacy]), {
    price: 220,
    needsConfig: false,
  });
  assert.deepEqual(
    lookupInvoicePrice(1, "Ribbon Black", "760x100", true, [legacy, unifiedPrices[1]]),
    { price: 217, needsConfig: false },
  );
  assert.deepEqual(
    lookupInvoicePrice(1, "Ribbon Black", "760 × 100", true, [unifiedPrices[1]]),
    { price: 217, needsConfig: false },
  );
  assert.deepEqual(
    lookupInvoicePrice(1, "Ribbon Pink", "760x100", true, [{
      ...unifiedPrices[2],
      category: "Ribbon",
      price: 217,
      confirmed: true,
    }]),
    { price: 217, needsConfig: false },
  );
});

test("inactive and unconfirmed prices do not become usable invoice prices", () => {
  assert.deepEqual(lookupInvoicePrice(1, "Ribbon Pink", "760x100", true, [unifiedPrices[2]]), {
    price: null,
    needsConfig: true,
  });
  assert.deepEqual(
    lookupInvoicePrice(1, "Ribbon Pink", "760x100", true, [{ ...unifiedPrices[2], active: false }]),
    { price: null, needsConfig: false, missing: true },
  );
  assert.deepEqual(lookupInvoicePrice(1, "Ribbon Pink", "760x150", true, unifiedPrices), {
    price: null,
    needsConfig: false,
    missing: true,
  });
});

test("issue uses the latest loaded catalog price instead of a stale initial zero", () => {
  const item = {
    category: "Black fabric",
    size: "760x100",
    unit_price: 0,
    price_override: false,
    _needsConfig: true,
  };
  assert.deepEqual(
    resolveInvoiceLineForIssue(item, 1, true, [{
      zone: 1,
      category: "Ribbon Black",
      size: "760x100",
      price: 217,
      active: true,
      confirmed: true,
    }]),
    { unitPrice: 217, needsConfig: false },
  );
  assert.deepEqual(
    resolveInvoiceLineForIssue(item, 1, true, [{
      zone: 1,
      category: "Ribbon Black",
      size: "760x100",
      price: null,
      active: true,
      confirmed: false,
    }]),
    { unitPrice: 0, needsConfig: true },
  );
});

test("manual-only ribbon dimensions stay manual outside unified company profiles", () => {
  for (const category of ["Ribbon Black", "Ribbon Pink", "Candy", "Black fabric", "Ribbon Balck"]) {
    assert.ok(isManualInvoicePrice(category, "1370x150", false));
    assert.ok(isManualInvoicePrice(category, "1370 × 150", false));
    assert.ok(!isManualInvoicePrice(category, "1370x150", true));
  }
});


test("custom stock categories match catalog prices regardless of letter casing", () => {
  const customPrice = {
    zone: 1,
    category: "Premium Foam",
    size: "910x100",
    price: 275,
    active: true,
    confirmed: true,
  };

  assert.equal(sameInvoicePriceCategory("PREMIUM FOAM", "premium foam", false), true);
  assert.deepEqual(
    lookupInvoicePrice(1, "PREMIUM FOAM", "910 × 100", false, [customPrice]),
    { price: 275, needsConfig: false },
  );
  assert.deepEqual(
    invoiceSizesFor(1, "PREMIUM FOAM", false, [customPrice], [
      { product: "premium foam", size: "1070x100" },
    ]),
    ["910x100", "1070x100"],
  );
});

test("case-only custom category variants appear once in invoice category selectors", () => {
  const categories = invoiceCategoriesFor(1, false, [{
    zone: 1,
    category: "Premium Foam",
    size: "910x100",
    price: 275,
    active: true,
    confirmed: true,
  }], [
    { product: "PREMIUM FOAM", size: "1070x100" },
  ]);

  assert.equal(categories.filter((category) => category.toLowerCase() === "premium foam").length, 1);
});

test("a case-variant existing stock price does not block invoice issue", () => {
  const item = {
    category: "premium foam",
    size: "910x100",
    qty: 4,
    unit_price: 0,
    price_override: false,
  };

  assert.deepEqual(
    resolveInvoiceLineForIssue(item, 1, false, [{
      zone: 1,
      category: "PREMIUM FOAM",
      size: "910x100",
      price: 275,
      active: true,
      confirmed: true,
    }]),
    { unitPrice: 275, needsConfig: false },
  );
});
