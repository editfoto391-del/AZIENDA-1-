import {
  LayoutDashboard, ContactRound, ReceiptText, Package, Factory, CalendarCheck,
  ShoppingBag, HandCoins, CarFront, Receipt, ChartNoAxesCombined, ShoppingCart,
  Building2, Handshake, Settings as Cog, ClipboardCheck,
  Warehouse, FlaskConical, Boxes,
} from "lucide-react";

export const NAV_GROUPS = [
  { id: "overview", label: "Overview", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true, section: "dashboard" },
  ] },
  { id: "sales", label: "Sales", items: [
    { to: "/customers", label: "Customers", icon: ContactRound, section: "customers" },
    { to: "/orders", label: "Orders", icon: ShoppingBag, section: "orders" },
    { to: "/invoices", label: "Invoice", icon: ReceiptText, section: "invoices" },
    { to: "/client-payments", label: "Clients payment and balances", icon: HandCoins, section: "client-payments" },
  ] },
  { id: "express", label: "Express Websites - Old Invoices and Payments", collapsible: true, items: [
    { to: "/express-invoices", label: "Express Website Invoices", icon: ReceiptText, section: "express-invoices" },
    { to: "/express-client-payments", label: "Express Website Payments and Balances", icon: HandCoins, section: "express-client-payments" },
  ] },
  { id: "purchasing", label: "Purchasing", items: [
    { to: "/intercompany", label: "Intercompany", icon: Building2, section: "intercompany" },
    { to: "/grv", label: "GRV", icon: ClipboardCheck, section: "grv" },
    { to: "/suppliers", label: "Suppliers", icon: Handshake, section: "suppliers" },
    { to: "/buyings", label: "Buyings", icon: ShoppingCart, section: "buyings" },
  ] },
  { id: "operations", label: "Operations", items: [
    { to: "/stock", label: "Stock", icon: Package, section: "stock" },
    { to: "/fleet", label: "Fleet", icon: CarFront, section: "fleet" },
  ] },
  { id: "company-inventory", label: "COMPANY INVENTORY", collapsible: true, items: [
    { to: "/company-inventory", label: "Company Inventory", icon: Boxes, section: "company-inventory" },
  ] },
  { id: "production", label: "PRODUCTION", collapsible: true, companyIds: ["superiqfoam"], items: [
    { to: "/production", label: "Production", icon: Factory, section: "production" },
    { to: "/warehouses/chemical-inventory", label: "Chemicals Quantity", icon: FlaskConical, section: "chemicals-quantity", companyId: "superiqfoam" },
    { to: "/warehouses/chemical", label: "Chemical Usage Log", icon: FlaskConical, section: "chemical-usage-log", companyId: "superiqfoam" },
  ] },
  { id: "warehouses", label: "WAREHOUSES", collapsible: true, companyId: "iqfoam-manufactoring", items: [
    { to: "/warehouses/A", label: "Warehouse A", icon: Warehouse, section: "warehouse-a", warehouseId: "A" },
    { to: "/warehouses/B", label: "Warehouse B", icon: Warehouse, section: "warehouse-b", warehouseId: "B" },
    { to: "/warehouses/C", label: "Warehouse C", icon: Warehouse, section: "warehouse-c", warehouseId: "C" },
    { to: "/warehouses/chemical", label: "Chemical", icon: FlaskConical, section: "warehouse-chemical" },
    { to: "/warehouses/chemical-inventory", label: "Chemical Inventory", icon: Boxes, section: "warehouse-chemical-inventory" },
  ] },
  { id: "finance-team", label: "Finance & team", items: [
    { to: "/expenses", label: "Expenses", icon: Receipt, section: "expenses" },
    { to: "/daily-report", label: "Daily Report", icon: ChartNoAxesCombined, section: "daily-report" },
    { to: "/attendance", label: "Attendance", icon: CalendarCheck, section: "attendance" },
  ] },
  { id: "administration", label: "Administration", items: [
    { to: "/settings", label: "Settings", icon: Cog, section: "settings" },
  ] },
];

export function navigationLinksForCompany(companyId) {
  const links = NAV_GROUPS.flatMap((group) => {
    if ((group.companyId && group.companyId !== companyId)
      || (group.companyIds && !group.companyIds.includes(companyId))) return [];
    return group.items
      .filter((item) => !item.globalOwnerOnly)
      .filter((item) => !item.companyId || item.companyId === companyId)
      .map((item) => ({ path: item.to, label: item.label, section: item.section }));
  });
  return [...new Map(links.map((link) => [link.path, link])).values()];
}
