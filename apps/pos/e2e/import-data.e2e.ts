import { expect, test } from "@playwright/test";

const API = "http://localhost:4000";
const OWNER_WEB = "http://localhost:3000";
const BRANCH = "e2e-pos-branch";

// The owner brings in opening stock from the old software: one row matches the master list, one could be either of
// two medicines and needs a decision, one is the shop's own item. Nothing is imported until they press Import.
test("owner imports opening stock, settling an unclear match by hand", async ({ page, request }) => {
  await page.goto(OWNER_WEB);
  await page.getByLabel("Login").fill("e2e-pos-owner@test.local");
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Import data", exact: true }).click();

  const file = ["Item Name,Batch No,Expiry,Qty,MRP", "FLAGYL TAB 400 MG,F-E2E,12/2028,3,", "Augmentin,A-E2E,12/2028,2,", "Herbal Balm E2E,H-E2E,06/2028,5,250"].join("\r\n");
  await page.locator("input[type=file]").setInputFiles({ name: "old-stock.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
  await page.getByRole("button", { name: "Upload and check" }).click();
  // The first upload also compiles the import route on the dev server, which can take a while.
  await expect(page.locator(".imp-message")).toContainText("3 rows read. 1 need a decision", { timeout: 90_000 });

  // The unclear row: choose Augmentin 625mg, not 1g.
  const augmentin = page.getByRole("row", { name: /Augmentin/ });
  await augmentin.getByRole("button", { name: /Augmentin 625mg/ }).click();
  await expect(page.locator(".imp-message")).toContainText("Line 3 decided");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Import 3 rows" }).click();
  await expect(page.locator(".imp-message")).toContainText("Imported");

  await request.post(`${API}/api/v1/auth/login`, { data: { login: "e2e-pos-owner@test.local", credential: "e2e-password-123" } });
  const inventory = await (await request.get(`${API}/api/v1/inventory?branchId=${BRANCH}`)).json() as { items: Array<{ name: string; sellable: number }> };
  expect(inventory.items.map((item) => item.name)).toEqual(expect.arrayContaining(["Flagyl 400mg", "Augmentin 625mg", "Herbal Balm E2E"]));
  expect(await (await request.get(`${API}/api/v1/inventory/ledger?branchId=${BRANCH}`)).json()).toEqual({ mismatches: [] });

  // The same file again is refused, so stock can never be doubled.
  await page.getByRole("button", { name: "← All imports" }).click();
  await page.locator("input[type=file]").setInputFiles({ name: "old-stock-again.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
  await page.getByRole("button", { name: "Upload and check" }).click();
  await expect(page.locator(".imp-message")).toContainText("already imported");
});
