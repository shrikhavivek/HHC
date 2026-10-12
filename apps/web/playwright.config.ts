import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "editorial.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.HHC_TEST_BASE_URL || "http://localhost:3200",
    browserName: "chromium",
    channel: process.env.HHC_TEST_BROWSER || "msedge",
    headless: true,
    trace: "retain-on-failure",
  },
});
