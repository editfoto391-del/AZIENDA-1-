import { test, expect, signInAsMockUser } from "./fixtures.js";

const mockPassword = "not-a-real-password";

test("login rejects mock credentials and shows a recoverable error", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("company-profile-test-company").click();
  await page.getByTestId("login-username").fill("mock-denied");
  await page.getByTestId("login-password").fill(mockPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toContainText("Mock login rejected");
  expect(page.url()).toContain("/login");
});

test("mock login completes and opens the dashboard", async ({ page, mockApi }) => {
  await page.goto("/login");
  await page.getByTestId("company-profile-test-company").click();
  await page.getByTestId("login-password").fill(mockPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "Business overview" })).toBeVisible();
  expect(mockApi.some((call) => call.path === "/auth/login" && call.method === "POST")).toBeTruthy();
});

test("dashboard period controls and quick action navigate to invoices", async ({ page }) => {
  await signInAsMockUser(page);
  await expect(page.getByTestId("dashboard-period-controls")).toBeVisible();
  await page.getByTestId("dashboard-period-week").click();
  await expect(page.getByTestId("dashboard-period-week")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("quick-create-invoice").click();
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByRole("button", { name: /Back to Invoices/i })).toBeVisible();
});

test("invoice search, status filter, and invoice details work with mock records", async ({ page, mockApi }) => {
  await signInAsMockUser(page, "/invoices");
  await expect(page.getByTestId("invoice-row-mock-invoice-1")).toBeVisible();
  await page.getByTestId("invoice-search").fill("E2E-INV");
  await page.getByTestId("invoice-status-filter").selectOption("issued");
  await expect.poll(() => mockApi.some((call) => call.path === "/invoices" && call.search.includes("q=E2E-INV") && call.search.includes("status=issued"))).toBeTruthy();
  await page.getByTestId("view-invoice-row-mock-invoice-1").click();
  await expect(page.getByTestId("invoice-details-mock-invoice-1")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invoice Details E2E-INV-001" })).toBeVisible();
});

test("expenses search, category filter, details, and validation are isolated", async ({ page, mockApi }) => {
  await signInAsMockUser(page, "/expenses");
  await expect(page.getByTestId("expense-row-mock-expense-1")).toBeVisible();
  await page.getByTestId("expense-search-input").fill("office supplies");
  await page.getByTestId("expense-filter-category").selectOption("General");
  await page.getByTestId("view-expense-mock-expense-1").click();
  await expect(page.getByText("Expense Details")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("add-expense-btn").click();
  await page.getByTestId("save-expense-btn").click();
  await expect(page.getByText("Description required")).toBeVisible();
  expect(mockApi.some((call) => call.path === "/expenses" && call.method === "POST")).toBeFalsy();
});

test("GRV filters, detail view, and supplier validation work with mock data", async ({ page, mockApi }) => {
  await signInAsMockUser(page, "/grv");
  await expect(page.getByTestId("grv-row-mock-grv-1")).toBeVisible();
  await page.getByTestId("grv-status-filter").selectOption("draft");
  await expect.poll(() => mockApi.some((call) => call.path === "/grvs" && call.search.includes("status=draft"))).toBeTruthy();
  await page.getByTestId("grv-view-mock-grv-1").click();
  await expect(page.getByRole("heading", { name: "GRV E2E-GRV-001" })).toBeVisible();
  await page.getByTestId("modal-close").click();
  await page.getByTestId("grv-create").click();
  await page.getByTestId("grv-save-draft").click();
  await expect(page.getByText("Choose a supplier")).toBeVisible();
  expect(mockApi.some((call) => call.path === "/grvs" && call.method === "POST")).toBeFalsy();
});

test("orders filter, search, details, and create validation are covered", async ({ page, mockApi }) => {
  await signInAsMockUser(page, "/orders");
  await expect(page.getByTestId("order-row-mock-order-1")).toBeVisible();
  await page.getByTestId("order-filter-to-send").click();
  await page.getByTestId("order-search").fill("E2E-ORDER");
  await expect.poll(() => mockApi.some((call) => call.path === "/orders" && call.search.includes("q=E2E-ORDER"))).toBeTruthy();
  await page.getByTestId("view-order-mock-order-1").click();
  await expect(page.getByTestId("order-details-mock-order-1")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("add-order-btn").click();
  await page.getByTestId("save-order-btn").click();
  await expect(page.getByText("Customer required")).toBeVisible();
  expect(mockApi.some((call) => call.path === "/orders" && call.method === "POST")).toBeFalsy();
});

test("payments search, balance details, and amount validation use fixtures only", async ({ page, mockApi }) => {
  await signInAsMockUser(page, "/client-payments");
  await expect(page.getByTestId("client-balance-row-mock-customer-1")).toBeVisible();
  await page.getByTestId("client-payments-search").fill("Sample Client");
  await page.getByTestId("client-balance-filter-with-balance").click();
  await page.getByTestId("view-client-balance-mock-customer-1").click();
  await expect(page.getByTestId("client-outstanding")).toBeVisible();
  await page.getByTestId("make-payment-mock-invoice-1").click();
  await page.getByTestId("client-payment-amount").fill("0");
  await page.getByTestId("confirm-client-payment").click();
  await expect(page.getByText("Amount must be greater than 0")).toBeVisible();
  expect(mockApi.some((call) => call.path === `/invoices/mock-invoice-1/payments` && call.method === "POST")).toBeFalsy();
});

test("mobile orders render the card layout and navigation drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsMockUser(page, "/orders");
  await expect(page.getByTestId("order-card-mock-order-1")).toBeVisible();
  await expect(page.getByTestId("order-row-mock-order-1")).toBeHidden();
  await page.getByTestId("menu-toggle").click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
