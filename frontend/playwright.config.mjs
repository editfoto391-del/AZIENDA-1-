import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:43127";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "test-results",
  webServer: {
    command: "yarn dev --host 127.0.0.1 --port 43127 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DISABLE_VISUAL_EDITS: "true", DISABLE_EMERGENT_OVERLAY: "true" },
  },
});
