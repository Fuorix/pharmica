import { defineConfig } from "vitest/config";

// Integration tests run against a dedicated database, never the development one.
export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5433/pharmica_test";

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDatabaseUrl, NODE_ENV: "test" },
    globalSetup: ["./test/global-setup.ts"],
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000
  }
});
