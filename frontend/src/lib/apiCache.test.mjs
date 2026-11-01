import assert from "node:assert/strict";
import test from "node:test";
import { GET_CACHE_MS, isCacheEntryFresh, pruneExpiredCache } from "./apiCache.mjs";

test("cached GET data stays fresh until the configured expiry boundary", () => {
  const entry = { expiresAt: 50_000 + GET_CACHE_MS };
  assert.equal(isCacheEntryFresh(entry, 79_999), true);
  assert.equal(isCacheEntryFresh(entry, 80_000), false);
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
