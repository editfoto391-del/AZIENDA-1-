export const normalizeStockLabel = (value) =>
  String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

export const canonicalStockProduct = (value, aliases = {}) => {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return Object.entries(aliases).find(([canonical, values]) =>
    [canonical, ...values].some((alias) => normalizeStockLabel(alias) === normalizeStockLabel(name))
  )?.[0] || name;
};

export const deduplicateStockRows = (items, aliases = {}) => {
  const latest = new Map();
  items.forEach((stock) => {
    const product = canonicalStockProduct(stock.product, aliases);
    const size = String(stock.size || "").trim().replace(/\s+/g, " ");
    const key = `${normalizeStockLabel(product)}|${normalizeStockLabel(size)}`;
    const existing = latest.get(key);
    if (!existing || String(stock.created_at || "") > String(existing.created_at || "")) {
      latest.set(key, { ...stock, product, size });
    }
  });
  return [...latest.values()];
};

export const uniqueStockCategories = (items, aliases = {}) => {
  const categories = new Map();
  items.forEach((item) => {
    const name = canonicalStockProduct(item.product, aliases);
    if (!name) return;
    const key = normalizeStockLabel(name);
    const existing = categories.get(key);
    const isUppercase = (value) => value !== value.toLowerCase() && value === value.toUpperCase();
    if (!existing || (isUppercase(existing) && !isUppercase(name))) categories.set(key, name);
  });
  return [...categories.values()].filter((name) => {
    const trimmed = String(name).trim();
    return trimmed === trimmed.toLowerCase() || trimmed !== trimmed.toUpperCase();
  });
};
