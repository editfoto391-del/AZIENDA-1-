const UNIFIED_PRICE_COMPANIES = new Set(["iqfoam-manufactoring", "iqfoam-whole-sallers"]);

const DEDICATED_COMPANY_DOMAINS = {};

export const dedicatedCompanyDomain = () =>
  DEDICATED_COMPANY_DOMAINS[window.location.hostname.toLowerCase()] || null;

export const usesUnifiedPriceList = (companyId) => UNIFIED_PRICE_COMPANIES.has(companyId);

export const includePreviousInvoiceBalanceByDefault = (companyId) => companyId !== "superiqfoam";

export const companyBrandName = (companyId) => ({
  "iqfoam-whole-sallers": "IQ FOAM WHOLESALERS",
  "iqfoam-manufactoring": "IQ FOAM MANUFACTURING",
}[companyId] || "SUPER IQ-FOAM");

export const companyProfileName = (companyId) => ({
  "iqfoam-whole-sallers": "IQFOAM WHOLESALERS",
  "iqfoam-manufactoring": "IQFOAM MANUFACTURING",
}[companyId] || "SUPERIQFOAM");

export const companyDailyReportName = (companyId) => ({
  "iqfoam-whole-sallers": "IQFOAM WHOLESALERS",
  "iqfoam-manufactoring": "IQFOAM MANUFACTURING",
}[companyId] || "SUPER IQ-FOAM");

export const companyDisplayName = (name) => {
  if (!name) return "SUPERIQFOAM";
  if (/wholesale/i.test(name)) return "IQ FOAM WHOLESALERS";
  if (/manufactur|manufactor/i.test(name)) return "IQ FOAM MANUFACTURING";
  if (/super/i.test(name) && /iq\s*[- ]?foam/i.test(name)) return "SUPERIQFOAM";
  if (/iq\s*[- ]?foam/i.test(name)) return "IQFOAM";
  return name;
};

export const invoiceCustomerBalanceLabels = (companyName) => (
  /wholesale/i.test(companyName || "")
    ? {
      option: "SHOW REMAINING BLN ON INVOICE",
      invoice: "REMAINING BLN ON INVOICE",
    }
    : {
      option: "SHOW REMAINING BLN FROM PREVIOUS INVOICES ON INVOICE",
      invoice: "REMAINING BLN FROM PREVIOUS INVOICES",
    }
);