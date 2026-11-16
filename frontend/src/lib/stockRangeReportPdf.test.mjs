import assert from "node:assert/strict";
import test from "node:test";
import { jsPDF } from "jspdf";
import { PRODUCT_RANGE_SECTIONS } from "./stockRangeReport.mjs";
import { drawStockRangeReportPdf } from "./stockRangeReportPdf.mjs";

test("stock report PDF renders all sections directly on two A4 pages", () => {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  drawStockRangeReportPdf(pdf, PRODUCT_RANGE_SECTIONS, {
    blank: false,
    getQuantity: () => "42",
  });

  assert.equal(pdf.getNumberOfPages(), 2);
  const content = pdf.output();
  for (const text of [
    "PRODUCT RANGE REPORT - PAGE 1 OF 2",
    "RIBBON RANGE",
    "1070 X 100",
    "1370 X 150",
    "CANDY RANGE",
    "STRONG BOY RANGE",
    "UNCOVERED RANGE",
  ]) {
    assert.ok(content.includes(text), `Expected PDF to contain "${text}"`);
  }
});

test("blank stock calculation PDF leaves quantity cells empty", () => {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  drawStockRangeReportPdf(pdf, PRODUCT_RANGE_SECTIONS, {
    blank: true,
    getQuantity: () => "QUANTITY_MARKER",
  });

  assert.equal(pdf.getNumberOfPages(), 2);
  assert.ok(!pdf.output().includes("QUANTITY_MARKER"));
});
