import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSentryEvent } from "./sentryPrivacy.mjs";

test("Sentry events omit personal, request, and business content", () => {
  const source = {
    message: "Invoice for a named customer",
    request: { url: "/invoices/customer-id?salary=1000", data: { amount: 1000 } },
    user: { email: "person@example.com" },
    contexts: { app: { customer: "Customer name" } },
    breadcrumbs: [{ message: "Viewed invoice" }],
    extra: { invoice: "invoice content" },
    tags: { company: "customer company" },
    transaction: "/invoices/customer-id",
    exception: {
      values: [{
        type: "TypeError",
        value: "Could not render customer invoice",
        mechanism: { type: "generic", data: { value: "private" } },
        stacktrace: {
          frames: [{
            filename: "https://app.example/assets/app.js?token=secret#fragment",
            vars: { salary: 1000 },
            context_line: "customer invoice content",
            function: "renderInvoice",
          }],
        },
      }],
    },
  };

  const sanitized = sanitizeSentryEvent(source);

  for (const field of ["message", "request", "user", "contexts", "breadcrumbs", "extra", "tags", "transaction"]) {
    assert.equal(field in sanitized, false, `${field} should not be sent`);
  }
  const [exception] = sanitized.exception.values;
  assert.equal(exception.value, undefined);
  assert.equal(exception.type, "TypeError");
  assert.deepEqual(exception.mechanism, { type: "generic" });
  assert.equal(exception.stacktrace.frames[0].filename, "https://app.example/assets/app.js");
  assert.equal(exception.stacktrace.frames[0].vars, undefined);
  assert.equal(exception.stacktrace.frames[0].context_line, undefined);
  assert.equal(exception.stacktrace.frames[0].function, "renderInvoice");
  assert.equal(source.exception.values[0].value, "Could not render customer invoice");
});
