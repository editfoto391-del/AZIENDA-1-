import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceCustomerBalanceLabels } from "./company.js";

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
