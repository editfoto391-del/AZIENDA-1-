import assert from "node:assert/strict";
import test from "node:test";

import { companyProfileName } from "./company.js";
import { navigationLinksForCompany } from "./navigation.js";

test("IMRAAN PLASTICS uses the correct profile name and only requested sections", () => {
  const links = navigationLinksForCompany("imraan-plastics");

  assert.equal(companyProfileName("imraan-plastics"), "IMRAAN PLASTICS");
  assert.deepEqual(links.map((link) => link.section).sort(), [
    "attendance",
    "client-payments",
    "customers",
    "dashboard",
    "daily-report",
    "expenses",
    "fleet",
    "grv",
    "invoices",
    "orders",
    "stock",
    "suppliers",
    "settings",
  ].sort());
  assert.equal(
    links.find((link) => link.section === "client-payments")?.label,
    "Clients balances and payments",
  );
});

test("SuperIQFoam replaces the two chemical menu links with the monthly sheet", () => {
  const superIqLinks = navigationLinksForCompany("superiqfoam");
  const superIqSections = superIqLinks.map((link) => link.section);

  assert.ok(superIqSections.includes("superiqfoam-monthly-sheet"));
  assert.ok(!superIqSections.includes("chemicals-quantity"));
  assert.ok(!superIqSections.includes("chemical-usage-log"));

  const manufacturingLinks = navigationLinksForCompany("iqfoam-manufactoring");
  assert.ok(manufacturingLinks.some((link) =>
    link.path === "/warehouses/production-chemical-balance"
      && link.label === "Production Management & Chemical Balance"));
  assert.ok(!manufacturingLinks.some((link) =>
    ["warehouse-chemical", "warehouse-chemical-inventory"].includes(link.section)));
});
