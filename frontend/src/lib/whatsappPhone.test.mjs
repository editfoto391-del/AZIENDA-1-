import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWhatsAppPhone, resolveWhatsAppPhone } from "./whatsappPhone.mjs";

test("normalizes South African local and international WhatsApp numbers", () => {
  assert.equal(normalizeWhatsAppPhone("082 123 4567"), "27821234567");
  assert.equal(normalizeWhatsAppPhone("82 123 4567"), "27821234567");
  assert.equal(normalizeWhatsAppPhone("+27 82 123 4567"), "27821234567");
  assert.equal(normalizeWhatsAppPhone("+27 (0)82 123 4567"), "27821234567");
  assert.equal(normalizeWhatsAppPhone("0027 (0)82 123 4567"), "27821234567");
});

test("accepts valid international numbers and rejects invalid lengths", () => {
  assert.equal(normalizeWhatsAppPhone("+1 (415) 555-2671"), "14155552671");
  assert.equal(normalizeWhatsAppPhone("1234567"), "1234567");
  assert.equal(normalizeWhatsAppPhone("123456"), "");
  assert.equal(normalizeWhatsAppPhone("1234567890123456"), "");
});

test("uses a valid invoice phone when the customer profile phone is unavailable", () => {
  assert.equal(resolveWhatsAppPhone("", "082 123 4567"), "27821234567");
  assert.equal(resolveWhatsAppPhone("1", "+27 82 123 4567"), "27821234567");
});

test("accepts a South African phone entered without the +27 prefix in Client Number", () => {
  assert.equal(resolveWhatsAppPhone("", "", "82 123 4567"), "27821234567");
});
