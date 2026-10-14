// Usage: pnpm --filter @pharmica/database db:import-master <file.csv> [--source DRAP_IMPORT] [--reference "SRO 123(I)/2026"]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { importMasterProducts, readMasterCsv } from "../src/master-import.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { source: { type: "string", default: "DRAP_IMPORT" }, reference: { type: "string" } } });
if (!positionals[0]) {
  console.error("Usage: db:import-master <file.csv> [--source DRAP_IMPORT] [--reference <text>]");
  process.exit(1);
}

const { rows, issues } = readMasterCsv(readFileSync(positionals[0], "utf8"));
const db = new PrismaClient();
try {
  const result = await importMasterProducts(db, rows, { source: values.source, reference: values.reference });
  const problems = [...issues, ...result.issues].sort((a, b) => a.line - b.line);
  console.log(`Created ${result.created}, updated ${result.updated}, price changes ${result.priceChanges}, unchanged ${result.unchanged}, skipped ${problems.length}.`);
  for (const problem of problems) console.log(`  line ${problem.line}: ${problem.message}`);
} finally {
  await db.$disconnect();
}
