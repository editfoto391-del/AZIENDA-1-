export const GET_CACHE_MS = 30_000;

export function isCacheEntryFresh(entry, now) {
  return Boolean(entry && entry.expiresAt > now);
}

export function pruneExpiredCache(cache, now) {
  cache.forEach((value, key) => {
    if (!isCacheEntryFresh(value, now)) cache.delete(key);
  });
}
