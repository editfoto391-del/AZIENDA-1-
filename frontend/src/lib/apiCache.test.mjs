import assert from "node:assert/strict";
import test from "node:test";
import {
  GET_CACHE_MS,
  INVOICE_GET_CACHE_MS,
  getCacheDuration,
  isCacheEntryFresh,
  pruneExpiredCache,
} from "./apiCache.mjs";

test("invoice lists and details use a short dedicated cache window", () => {
  assert.equal(getCacheDuration("/invoices"), INVOICE_GET_CACHE_MS);
  assert.equal(getCacheDuration("/invoices/abc123?include=items"), INVOICE_GET_CACHE_MS);
  assert.equal(getCacheDuration("/invoices/next-number?year=2026"), GET_CACHE_MS);
  assert.equal(getCacheDuration("/invoices/customer-prices/customer-1"), GET_CACHE_MS);
  assert.equal(getCacheDuration("/dashboard"), GET_CACHE_MS);
});

test("cached GET data stays fresh until the configured expiry boundary", () => {
  const cachedAt = 50_000;
  const entry = { expiresAt: cachedAt + GET_CACHE_MS };
  assert.equal(isCacheEntryFresh(entry, cachedAt + GET_CACHE_MS - 1), true);
  assert.equal(isCacheEntryFresh(entry, cachedAt + GET_CACHE_MS), false);
  assert.equal(isCacheEntryFresh(null, 50_000), false);
});

test("cache expiry removes stale keys but preserves fresh entries", () => {
  const cache = new Map([
    ["expired", { expiresAt: 99 }],
    ["boundary", { expiresAt: 100 }],
    ["fresh", { expiresAt: 101 }],
  ]);
  pruneExpiredCache(cache, 100);
  assert.deepEqual([...cache.keys()], ["fresh"]);
});
