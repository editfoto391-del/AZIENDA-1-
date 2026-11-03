import { api } from "@/lib/api";

const invoiceEditor = () => import("@/pages/InvoiceEditor");

export const pageLoaders = {
  "/": () => import("@/pages/Dashboard"),
  "/customers": () => import("@/pages/Customers"),
  "/suppliers": () => import("@/pages/Suppliers"),
  "/client-payments": () => import("@/pages/ClientPayments"),
  "/express-client-payments": () => import("@/pages/ClientPayments"),
  "/buyings": () => import("@/pages/Buyings"),
  "/intercompany": () => import("@/pages/Intercompany"),
  "/invoices": () => import("@/pages/InvoiceList"),
  "/invoices/new": invoiceEditor,
  "/express-invoices": () => import("@/pages/InvoiceList"),
  "/express-invoices/new": invoiceEditor,
  "/orders": () => import("@/pages/Orders"),
  "/stock": () => import("@/pages/Stock"),
  "/production": () => import("@/pages/Production"),
  "/warehouses": () => import("@/pages/Warehouses"),
  "/warehouses/chemical": () => import("@/pages/ChemicalStock"),
  "/warehouses/chemical-inventory": () => import("@/pages/ChemicalInventory"),
  "/company-inventory": () => import("@/pages/CompanyInventory"),
  "/attendance": () => import("@/pages/Attendance"),
  "/fleet": () => import("@/pages/Fleet"),
  "/expenses": () => import("@/pages/Expenses"),
  "/costs": () => import("@/pages/Costs"),
  "/grv": () => import("@/pages/GRV"),
  "/daily-report": () => import("@/pages/DailyReport"),
  "/settings": () => import("@/pages/Settings"),
  "/workflow-builder": () => import("@/pages/WorkflowBuilder"),
};

const pageData = {
  "/": ["/dashboard"],
  "/customers": ["/customers"],
  "/suppliers": ["/suppliers"],
  "/client-payments": ["/customers"],
  "/express-client-payments": ["/customers", "/invoices?express=true"],
  "/buyings": ["/buyings"],
  "/intercompany": ["/intercompany/requests"],
  "/invoices": ["/invoices"],
  "/invoices/new": ["/customers", "/prices", "/settings"],
  "/express-invoices": ["/invoices?express=true"],
  "/express-invoices/new": ["/customers", "/prices", "/settings"],
  "/orders": ["/orders", "/customers", "/vehicles", "/stock", "/settings"],
  "/stock": ["/stock", "/stock/movements"],
  "/production": ["/production/daily"],
  "/warehouses": [],
  "/attendance": ["/employees", "/attendance", "/attendance/summary"],
  "/fleet": ["/vehicles", "/vehicles/records/all", "/spareparts"],
  "/expenses": ["/expenses", "/reports/profit", "/reports/costs", "/vehicles"],
  "/costs": ["/reports/costs"],
  "/grv": ["/grvs", "/grvs/dashboard", "/grvs/purchase-orders", "/suppliers", "/stock", "/settings"],
  "/settings": ["/settings", "/prices", "/drivers"],
  "/workflow-builder": [],
};

export function preloadPage(path) {
  const pathname = path.split("?")[0];
  const route = pathname.startsWith("/express-invoices/")
    ? "/express-invoices/new"
    : pathname.startsWith("/invoices/") ? "/invoices/new"
      : pathname.startsWith("/warehouses/") ? "/warehouses" : pathname;
  pageLoaders[route]?.().catch(() => {});
  pageData[route]?.forEach((endpoint) => api.get(endpoint).catch(() => {}));
}