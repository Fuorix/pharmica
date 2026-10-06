import { defineConfig } from "@playwright/test";

// End-to-end test of the counter against the real API and the development database.
// Uses the Microsoft Edge already installed on Windows, so no browser download is needed.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: "http://localhost:3002", channel: "msedge", trace: "retain-on-failure" },
  webServer: [
    { command: "pnpm --filter @pharmica/api dev", url: "http://localhost:4000/api/v1/health", reuseExistingServer: true, timeout: 180_000, cwd: "../.." },
    { command: "pnpm --filter @pharmica/pos dev", url: "http://localhost:3002", reuseExistingServer: true, timeout: 120_000, cwd: "../.." }
  ]
});
