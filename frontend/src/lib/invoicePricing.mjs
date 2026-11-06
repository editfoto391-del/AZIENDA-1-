const CATEGORY_LABELS = [
  "Simple/Mix color",
  "Standard",
  "Simple",
  "Ribbon",
  "Ribbon Black & Pink",
  "Ribbon Black",
  "Ribbon Pink",
  "Candy",
  "Strong Boy",
  "Uncovered",
  "Uncovered Blue 16 Density",
];

const CATEGORY_ALIASES = {
  black: "Ribbon Black",
  "black fabric": "Ribbon Black",
  "fabric black": "Ribbon Black",
  "ribbon balck": "Ribbon Black",
  "ribbon black fabric": "Ribbon Black",
  ribbon: "Ribbon Pink",
};

const CATEGORY_LABELS_BY_KEY = new Map(
  CATEGORY_LABELS.map((category) => [category.toLowerCase(), category]),
);

export const INVOICE_CATEGORIES = {
  1: ["Simple/Mix color", "Ribbon Black", "Ribbon Pink", "Candy", "Strong Boy", "Uncovered"],
  2: ["Simple/Mix color", "Ribbon Black", "Ribbon Pink", "Candy", "Strong Boy", "Uncovered Blue 16 Density"],
};

export const UNIFIED_INVOICE_CATEGORIES = ["Simple/Mix color", "Ribbon Black", "Ribbon Pink"];

const RIBBON_CATEGORIES = new Set(["Ribbon Black", "Ribbon Pink", "Candy"]);


export const canonicalInvoiceCategory = (category) => {
  const value = String(category || "").trim();
  const key = value.toLowerCase();
  return CATEGORY_ALIASES[key] || CATEGORY_LABELS_BY_KEY.get(key) || value;
};

export const invoicePriceCategory = (category, unifiedPriceList) => {
  const canonical = canonicalInvoiceCategory(category);
  if (["Standard", "Simple", "Simple/Mix color"].includes(canonical)) {
    return unifiedPriceList ? "Simple" : "Standard";
  }
  return canonical === "Candy" ? "Ribbon Black" : canonical;
};

// Backend price lookup is case-insensitive for category labels. Keep invoice
// selectors and issue validation aligned with that contract for custom stock products.
const invoicePriceCategoryKey = (category, unifiedPriceList) =>
  String(invoicePriceCategory(category, unifiedPriceList) || "").trim().toLowerCase();

export const sameInvoicePriceCategory = (left, right, unifiedPriceList) => {
  const leftKey = invoicePriceCategoryKey(left, unifiedPriceList);
  return Boolean(leftKey) && leftKey === invoicePriceCategoryKey(right, unifiedPriceList);
};

export const canonicalInvoiceSize = (size) => {
  const value = String(size || "").trim();
  if (!/^\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?){1,2}$/i.test(value)) return value;
  return value.replace(/×/g, "x").replace(/\s+/g, "").toLowerCase();
};

const invoiceStockProductKey = (category) => {
  const canonical = canonicalInvoiceCategory(category);
  if (["Standard", "Simple", "Simple/Mix color"].includes(canonical)) return "simple";
  if (canonical === "Candy") return "candy";
  return canonical.toLowerCase();
};

export const invoiceStockLinesChanged = (previousItems = [], nextItems = []) => {
  const quantitiesByProductAndSize = (items) => {
    const quantities = new Map();
    items.forEach((item) => {
      const size = canonicalInvoiceSize(item.size);
      const product = invoiceStockProductKey(item.category);
      if (!product || !size) return;
      const key = `${product}|${size.toLowerCase()}`;
      quantities.set(key, (quantities.get(key) || 0) + (Number(item.qty) || 0));
    });
    return [...quantities.entries()].sort(([left], [right]) => left.localeCompare(right));
  };

  return JSON.stringify(quantitiesByProductAndSize(previousItems))
    !== JSON.stringify(quantitiesByProductAndSize(nextItems));
};

export const isManualInvoicePrice = (category, size, unifiedPriceList) =>
  !unifiedPriceList
  && RIBBON_CATEGORIES.has(canonicalInvoiceCategory(category))
  && canonicalInvoiceSize(size) === "1370x150";

const displayInvoiceCategory = (category) => {
  const canonical = canonicalInvoiceCategory(category);
  return ["Standard", "Simple"].includes(canonical) ? "Simple/Mix color" : canonical;
};

export const invoiceCategoriesFor = (zone, unifiedPriceList, prices, stockItems) => {
  const defaults = unifiedPriceList ? UNIFIED_INVOICE_CATEGORIES : INVOICE_CATEGORIES[zone] || [];
  const configured = prices
    .filter((price) => price.zone === zone && price.active && price.category)
    .map((price) => displayInvoiceCategory(price.category));
  const stocked = stockItems
    .map((item) => displayInvoiceCategory(item.product))
    .filter(Boolean);
  const seen = new Set();
  return [...defaults, ...configured, ...stocked].filter((category) => {
    const key = String(category || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const invoiceSizesFor = (zone, category, unifiedPriceList, prices, stockItems) => {
  const priceCategory = invoicePriceCategory(category, unifiedPriceList);
  const pricedSizes = prices
    .filter((price) => price.zone === zone
      && sameInvoicePriceCategory(price.category, category, unifiedPriceList)
      && price.active)
    .map((price) => price.size);
  const stockedSizes = stockItems
    .filter((item) => sameInvoicePriceCategory(item.product, category, unifiedPriceList))
    .map((item) => item.size);
  return [...new Set([...pricedSizes, ...stockedSizes])];
};

export const lookupInvoicePrice = (zone, category, size, unifiedPriceList, prices) => {
  if (isManualInvoicePrice(category, size, unifiedPriceList)) {
    return { price: null, needsConfig: true };
  }
  const priceCategory = invoicePriceCategory(category, unifiedPriceList);
  const matches = prices.filter((price) => price.zone === zone
    && sameInvoicePriceCategory(price.category, category, unifiedPriceList)
    && canonicalInvoiceSize(price.size) === canonicalInvoiceSize(size)
    && price.active);
  const price = matches.find((item) =>
    String(item.category || "").trim().toLowerCase() === String(priceCategory || "").trim().toLowerCase()
  ) || matches[0];
  if (!price) return { price: null, needsConfig: false, missing: true };
  if (price.price == null || !price.confirmed) return { price: null, needsConfig: true };
  return { price: price.price, needsConfig: false };
};

export const resolveInvoiceLineForIssue = (item, zone, unifiedPriceList, prices) => {
  const unitPrice = Number(item.unit_price) || 0;
  if (!item.size || (item.price_override && unitPrice > 0)) {
    return { unitPrice, needsConfig: false };
  }
  const resolvedPrice = lookupInvoicePrice(zone, item.category, item.size, unifiedPriceList, prices);
  if (resolvedPrice.price != null) {
    return { unitPrice: resolvedPrice.price, needsConfig: false };
  }
  return {
    unitPrice,
    needsConfig: Boolean(resolvedPrice.needsConfig || resolvedPrice.missing),
  };
};
