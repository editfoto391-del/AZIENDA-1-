export const GET_CACHE_MS = 5_000;
export const INVOICE_GET_CACHE_MS = 15_000;

export function getCacheDuration(url) {
  const path = String(url || "").split("?")[0].replace(/^\/+/, "").replace(/\/+$/, "");
  return path === "invoices" || (/^invoices\/[^/]+$/.test(path) && path !== "invoices/next-number")
    ? INVOICE_GET_CACHE_MS
    : GET_CACHE_MS;
}

export function isCacheEntryFresh(entry, now) {
  return Boolean(entry && entry.expiresAt > now);
}

export function pruneExpiredCache(cache, now) {
  cache.forEach((value, key) => {
    if (!isCacheEntryFresh(value, now)) cache.delete(key);
  });
}
