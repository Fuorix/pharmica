import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@pharmica/database/client";
import { testDatabaseUrl } from "../vitest.config";

const databasePackage = fileURLToPath(new URL("../../../packages/database", import.meta.url));

/** Creates the test database if needed and applies all migrations to it. */
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl);
  const name = url.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Refusing to run tests against non-test database "${name}"`);

  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    const existing = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!existing.length) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  execSync("pnpm exec prisma migrate deploy", {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "pipe"
  });
}
