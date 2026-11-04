import assert from "node:assert/strict";
import test from "node:test";
import { GET_CACHE_MS, isCacheEntryFresh, pruneExpiredCache } from "./apiCache.mjs";

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
