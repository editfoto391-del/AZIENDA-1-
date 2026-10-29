import { api } from "@/lib/api";

const invoiceEditor = () => import("@/pages/InvoiceEditor");

export const pageLoaders = {
  "/": () => import("@/pages/Dashboard"),
  "/customers": () => import("@/pages/Customers"),
  "/suppliers": () => import("@/pages/Suppliers"),
  "/client-payments": () => import("@/pages/ClientPayments"),
  "/buyings": () => import("@/pages/Buyings"),
  "/invoices": () => import("@/pages/InvoiceList"),
  "/invoices/new": invoiceEditor,
  "/orders": () => import("@/pages/Orders"),
  "/stock": () => import("@/pages/Stock"),
  "/production": () => import("@/pages/Production"),
  "/attendance": () => import("@/pages/Attendance"),
  "/deliveries": () => import("@/pages/Deliveries"),
  "/fleet": () => import("@/pages/Fleet"),
  "/expenses": () => import("@/pages/Expenses"),
  "/costs": () => import("@/pages/Costs"),
  "/grv": () => import("@/pages/GRV"),
  "/daily-report": () => import("@/pages/DailyReport"),
  "/settings": () => import("@/pages/Settings"),
};

const pageData = {
  "/": ["/dashboard"],
  "/customers": ["/customers"],
  "/suppliers": ["/suppliers"],
  "/client-payments": ["/customers"],
  "/buyings": ["/buyings"],
  "/invoices": ["/invoices"],
  "/invoices/new": ["/customers", "/prices", "/settings"],
  "/orders": ["/orders", "/customers", "/vehicles", "/stock", "/settings"],
  "/stock": ["/stock", "/stock/movements"],
  "/production": ["/production/daily"],
  "/attendance": ["/employees", "/attendance", "/attendance/summary"],
  "/deliveries": ["/deliveries", "/customers", "/drivers", "/vehicles", "/stock"],
  "/fleet": ["/vehicles", "/vehicles/records/all", "/spareparts"],
  "/expenses": ["/expenses", "/reports/profit", "/reports/costs", "/vehicles"],
  "/costs": ["/reports/costs"],
  "/grv": ["/grvs", "/grvs/dashboard", "/grvs/purchase-orders", "/suppliers", "/stock", "/settings"],
  "/settings": ["/settings", "/prices", "/drivers"],
};

export function preloadPage(path) {
  const pathname = path.split("?")[0];
  const route = pathname.startsWith("/invoices/") ? "/invoices/new" : pathname;
  pageLoaders[route]?.().catch(() => {});
  pageData[route]?.forEach((endpoint) => api.get(endpoint).catch(() => {}));
}