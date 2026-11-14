import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultInvoicePaymentTerms,
  includePreviousInvoiceBalanceByDefault,
  invoiceCustomerBalanceLabels,
} from "./company.js";

test("Super IQ-Foam invoices default to 30 Days payment terms", () => {
  assert.equal(defaultInvoicePaymentTerms("superiqfoam"), "30 Days");
  assert.equal(defaultInvoicePaymentTerms("iqfoam-manufactoring"), "Due on Delivery");
});

test("previous invoice balance is hidden by default only for Super IQ-Foam", () => {
  assert.equal(includePreviousInvoiceBalanceByDefault("superiqfoam"), false);
  assert.equal(includePreviousInvoiceBalanceByDefault("iqfoam-manufactoring"), true);
  assert.equal(includePreviousInvoiceBalanceByDefault(undefined), true);
});

test("invoice customer balance labels match the company", () => {
  assert.deepEqual(invoiceCustomerBalanceLabels("IQ FOAM WHOLESALERS"), {
    option: "SHOW REMAINING BLN ON INVOICE",
    invoice: "REMAINING BLN ON INVOICE",
  });
  assert.deepEqual(invoiceCustomerBalanceLabels("SUPER IQ-FOAM"), {
    option: "SHOW REMAINING BLN FROM PREVIOUS INVOICES ON INVOICE",
    invoice: "REMAINING BLN FROM PREVIOUS INVOICES",
  });
});
