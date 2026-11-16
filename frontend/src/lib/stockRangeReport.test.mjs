import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_RANGE_PAGES, PRODUCT_RANGE_SECTIONS, REPORT_PRODUCT_NAMES, normalizeReportValue } from "./stockRangeReport.mjs";

const section = (title) => PRODUCT_RANGE_SECTIONS.find((item) => item.title === title);

test("ribbon report includes black and pink for all required sizes", () => {
  const expectedSizes = ["760", "910", "1070", "1370"].flatMap((width) =>
    ["100", "120", "150"].map((height) => `${width}x${height}`)
  );
  const ribbonRows = section("RIBBON RANGE").rows;

  assert.equal(ribbonRows.length, 24);
  assert.deepEqual([...new Set(ribbonRows.map((row) => row.size))], expectedSizes);
  assert.deepEqual([...new Set(ribbonRows.map((row) => row.group))], ["ribbon-black", "ribbon-pink"]);
});

test("Candy report covers sizes 760 through 1370 for all required dimensions", () => {
  const candyRows = section("CANDY RANGE").rows;

  assert.equal(candyRows.length, 12);
  assert.deepEqual(candyRows.map((row) => row.size), ["760", "910", "1070", "1370"].flatMap((width) =>
    ["100", "120", "150"].map((height) => `${width}x${height}`)
  ));
  assert.ok(REPORT_PRODUCT_NAMES.candy.has(normalizeReportValue("Candy")));
});

test("report pages keep sections ordered without missing or repeated sections", () => {
  assert.deepEqual(PRODUCT_RANGE_PAGES.map((page) => page.sections.map((item) => item.title)), [
    ["MIX-COLOR RANGE", "RIBBON RANGE"],
    ["CANDY RANGE", "STRONG BOY RANGE", "UNCOVERED RANGE"],
  ]);
  assert.equal(PRODUCT_RANGE_PAGES.flatMap((page) => page.sections).length, PRODUCT_RANGE_SECTIONS.length);
  assert.deepEqual(
    PRODUCT_RANGE_SECTIONS.flatMap((item) => item.rows.map((row) => row.number)),
    Array.from({ length: 62 }, (_, index) => index + 1),
  );
});
