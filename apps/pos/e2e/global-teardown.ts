import { runTenantScript } from "./global-setup";

export default function globalTeardown() {
  if (!process.env.E2E_KEEP_DATA) runTenantScript("cleanup");
}
