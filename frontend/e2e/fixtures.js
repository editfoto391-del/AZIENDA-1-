import { test as base, expect } from "@playwright/test";

const user = {
  id: "mock-user", name: "E2E Mock User", username: "e2e-user",
  email: "e2e-user@example.invalid", company_id: "test-company", role: "owner",
  is_owner: true, is_admin: true, is_company_owner: true,
  can_skip_supervisor_approval: true,
};
const invoice = {
  id: "mock-invoice-1", number: "E2E-INV-001", customer_id: "mock-customer-1",
  customer_name: "Sample Client", date: "2026-01-15", due_date: "2026-02-15",
  status: "issued", total: 250, amount_paid: 50, outstanding: 200,
  items: [{ category: "Sample item", size: "10x20", qty: 1, unit_price: 250, line_total: 250 }],
};
const customer = {
  id: "mock-customer-1", name: "Sample Client", phone: "000-000-0000",
  email: "client@example.invalid", default_zone: 1, payment_terms: "30 days", other_balance: 0,
};
const expense = {
  id: "mock-expense-1", description: "Mock office supplies", amount: 125,
  date: "2026-01-15", category: "General", payment_method: "Cash",
  reference: "MOCK-REF", notes: "Fixture only",
};
const grv = {
  id: "mock-grv-1", grv_number: "E2E-GRV-001", received_date: "2026-01-15",
  supplier_id: "mock-supplier-1", supplier_name: "Mock Supplier",
  delivery_note_number: "MOCK-DN-01", status: "draft",
  items: [{ product: "Mock product", size: "10x20", accepted_quantity: 2, unit_cost: 5 }], vat_rate: 0,
};
const order = {
  id: "mock-order-1", reference: "E2E-ORDER-001", customer_id: customer.id,
  customer_name: customer.name, destination: "Mock City", status: "To Send",
  priority: "Normal", items: [{ qty: 2, category: "Mock product", size: "10x20" }],
};
const paymentSummary = { invoices: [invoice], outstanding: 200, other_balance: 0, other_balance_payments: [], payments: [] };
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const dashboard = () => ({
  period_profit: {}, previous_period_profit: {}, period_start: "2026-01-01", period_end: "2026-01-31",
  previous_period_start: "2025-12-01", previous_period_end: "2025-12-31",
  fleet_alerts: { items: [] }, orders_to_send: [],
});

export const test = base.extend({
  mockApi: [async ({ page }, use, testInfo) => {
    const calls = [];
    const origin = new URL(testInfo.project.use.baseURL || "http://127.0.0.1:3000").origin;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        calls.push({ external: url.origin, path: url.pathname });
        await route.abort("blockedbyclient");
        return;
      }
      if (!/^\/(?:__api|api)\//.test(url.pathname)) return route.continue();
      const request = route.request();
      const method = request.method();
      const path = url.pathname.replace(/^\/(?:__api|api)/, "");
      calls.push({ method, path, search: url.search });

      if (path === "/auth/me") return route.fulfill(request.headers()["authorization"] ? json(user) : json({ detail: "Mock unauthenticated" }, 401));
      if (path === "/companies/profiles") return route.fulfill(json([{ id: "test-company", name: "Mock Company", username: "e2e-user" }]));
      if (path === "/auth/login" && method === "POST") {
        const body = request.postDataJSON();
        return body.username === "mock-denied"
          ? route.fulfill(json({ detail: "Mock login rejected" }, 401))
          : route.fulfill(json({ token: "mock-token-only", user }));
      }
      if (path === "/auth/device") return route.fulfill(json({ ok: true }));
      if (path === "/dashboard") return route.fulfill(json(dashboard()));
      if (path === "/invoices" && method === "GET") {
        return route.fulfill(json(url.searchParams.has("page") ? { items: [invoice], total: 1 } : [invoice]));
      }
      if (path === `/invoices/${invoice.id}`) return route.fulfill(json(invoice));
      if (path === `/customers/${customer.id}`) return route.fulfill(json(customer));
      if (path === `/customers/${customer.id}/summary`) return route.fulfill(json(paymentSummary));
      if (path === "/customers") return route.fulfill(json([customer]));
      if (path === "/expenses") return route.fulfill(json([expense]));
      if (path === "/reports/profit") return route.fulfill(json({
        today: { expenses: 0 }, week: { expenses: 0 }, month: { expenses: 0 },
        week_start: "2026-01-01", week_end: "2026-01-07", month_start: "2026-01-01", month_end: "2026-01-31",
      }));
      if (path === "/reports/costs") return route.fulfill(json({ by_category: {}, by_vehicle: {}, rows: [] }));
      if (path === "/grvs") return route.fulfill(json([grv]));
      if (path === "/grvs/dashboard") return route.fulfill(json({ total_grvs: 1, pending_grvs: 1, completed_grvs: 0, company_profile_name: "Mock Company" }));
      if (path === "/orders") return route.fulfill(json({ items: [order], total: 1, status_counts: { open: 1 } }));
      if (path === "/suppliers") return route.fulfill(json([{ id: "mock-supplier-1", name: "Mock Supplier" }]));
      if (path === "/intercompany/invoices/received") return route.fulfill(json([]));
      if (path === "/settings" || path === "/print-templates") return route.fulfill(json({}));
      if (["/vehicles", "/stock", "/prices", "/access/workers", "/grvs/purchase-orders", "/payments/summary", "/express-payments"].includes(path)) return route.fulfill(json([]));
      // Fail closed to local mock responses: no API request can reach a backend.
      return route.fulfill(json(method === "GET" ? [] : { ok: true }));
    });
    await use(calls);
  }, { auto: true }],
});

export { expect };

export async function signInAsMockUser(page, path = "/") {
  await page.addInitScript(() => {
    localStorage.setItem("token", "mock-token-only");
    sessionStorage.setItem("owner-welcome-session", "mock-token-only");
  });
  await page.goto(path);
}
