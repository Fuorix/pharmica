import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databasePackage = fileURLToPath(new URL("../../../packages/database", import.meta.url));
const script = fileURLToPath(new URL("./tenant.mjs", import.meta.url));

export function runTenantScript(command: "setup" | "cleanup") {
  execFileSync(process.execPath, [script, command], { cwd: databasePackage, stdio: "inherit" });
}

export default function globalSetup() {
  runTenantScript("setup");
}
