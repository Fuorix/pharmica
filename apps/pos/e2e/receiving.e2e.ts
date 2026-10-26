import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4000";
const BRANCH = "e2e-pos-branch";

type Fixture = { receive: { barcode: string; unitsPerPack: number; tabletsPerStrip: number; officialRetailPrice: number } };
const fixture = () => JSON.parse(readFileSync(new URL("./.tenant.json", import.meta.url), "utf8")) as Fixture;
const notice = (page: Page) => page.getByRole("status");

test("a counter receives a never-stocked medicine from its 2D code with no internet, sells it, writes off damage, and the server agrees", async ({ page, request }) => {
  const { receive } = fixture();
  const perPack = receive.unitsPerPack * receive.tabletsPerStrip;

  await page.goto("/");
  // Setting the counter up with the cashier's PIN signs the cashier in.
  await page.getByLabel("Counter name").fill("E2ETST-2");
  await page.getByLabel("Your PIN").fill("1234");
  await page.keyboard.press("Enter");
  await page.getByLabel("Opening cash (PKR)").fill("0");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Shift opened");

  // The counter keeps the master medicine list, so a first-time medicine can be received with no internet.
  await page.locator(".sync-pill").click();
  await expect(page.getByText(/[1-9][d,]* medicines from the master list stored on this counter/)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.route(`${API}/**`, (route) => route.abort("internetdisconnected"));

  // Receive offline: scan the pack's GS1 DataMatrix. Product, batch, expiry, and serial come from the code.
  await page.keyboard.press("Control+2");
  await page.getByLabel("Supplier").fill("E2E Distributor");
  await page.getByLabel("Invoice no.").fill("INV-9");
  await page.getByLabel("Scan or search").fill(`(01)0${receive.barcode}(17)271200(10)E2E-BR1(21)SN0001`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".draft h3")).toContainText("first time in this branch");
  await expect(page.getByLabel("Batch no.")).toHaveValue("E2E-BR1");
  await expect(page.getByLabel("Expiry")).toHaveValue("2027-12-31");
  await page.getByLabel("Packs", { exact: true }).fill("2");
  await page.getByLabel("Bonus packs").fill("1");
  await page.getByLabel("Cost / pack").fill("280");
  await expect(page.getByLabel("Retail / pack (printed)")).toHaveValue(String(receive.officialRetailPrice));
  await page.keyboard.press("Enter");
  await expect(page.locator(".receive-totals")).toContainText("Bonus packs 1");
  await expect(page.locator(".receive-totals")).toContainText("Payable PKR 560.00");
  await page.keyboard.press("Control+Enter");
  await expect(notice(page)).toContainText("Received 3 packs from E2E Distributor");

  // Still offline, the received batch sells straight away.
  await page.keyboard.press("Control+1");
  await page.keyboard.type("brufen");
  await expect(page.locator(".results")).toContainText("3 packs");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F10");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText(`PKR ${receive.officialRetailPrice.toFixed(2)}`);

  // Write off a damaged pack, with a reason.
  await page.keyboard.press("Control+3");
  await page.getByLabel("Filter stock").fill("brufen");
  await page.locator(".stock-table tbody tr").first().click();
  await page.getByLabel("Kind").selectOption("DAMAGE");
  await page.getByLabel("Packs", { exact: true }).fill("1");
  await page.getByPlaceholder("Reason (required)").fill("Crushed box");
  await page.getByRole("button", { name: "Remove stock" }).click();
  await expect(notice(page)).toContainText("Stock change saved");
  await expect(page.locator(".stock-table tbody tr").first()).toContainText("1 packs");

  // Back online: everything reaches the server, and stock matches the ledger.
  await page.unroute(`${API}/**`);
  await page.locator(".sync-pill").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sync-pill")).toHaveText("Online", { timeout: 30_000 });

  await request.post(`${API}/api/v1/auth/login`, { data: { login: "e2e-pos-owner@test.local", credential: "e2e-password-123" } });
  const inventory = await (await request.get(`${API}/api/v1/inventory?branchId=${BRANCH}`)).json() as { items: Array<{ name: string; sellable: number }> };
  expect(inventory.items.find((item) => item.name === "Brufen 400mg")?.sellable).toBe(perPack);
  expect(await (await request.get(`${API}/api/v1/inventory/ledger?branchId=${BRANCH}`)).json()).toEqual({ mismatches: [] });
  const purchases = await (await request.get(`${API}/api/v1/purchases?branchId=${BRANCH}`)).json() as { purchases: Array<{ invoiceNumber: string; bonusPacks: number; total: number; lines: Array<{ batchNo: string }> }> };
  expect(purchases.purchases[0]).toMatchObject({ invoiceNumber: "INV-9", bonusPacks: 1, total: 560, lines: [{ batchNo: "E2E-BR1" }] });
});
