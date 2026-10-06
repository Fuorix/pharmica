import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4000";
const BRANCH = "e2e-pos-branch";

/** The internet is "down": every call to the Pharmica API fails, while the counter app itself stays loaded. */
const cutInternet = (page: Page) => page.route(`${API}/**`, (route) => route.abort("internetdisconnected"));
const restoreInternet = (page: Page) => page.unroute(`${API}/**`);

async function signInCashier(page: Page) {
  await expect(page.getByText("Who is at the counter?")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("1");
  await page.getByLabel("PIN for E2E Cashier").fill("1234");
  await page.keyboard.press("Enter");
}

const notice = (page: Page) => page.getByRole("status");

test("a counter bills, voids, and returns with the internet down, survives a restart, then syncs once", async ({ page, request }) => {
  // Printing opens the system dialog; record calls instead.
  await page.addInitScript(() => {
    (window as unknown as { prints: number }).prints = 0;
    window.print = () => { (window as unknown as { prints: number }).prints++; };
  });

  // Activate the counter once (needs the internet), sign in, and open the shift.
  await page.goto("/");
  await page.getByLabel("Activation code").fill("E2EPOSCODE01");
  await page.keyboard.press("Enter");
  await signInCashier(page);
  await page.getByLabel("Opening cash (PKR)").fill("5000");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Shift opened");

  await cutInternet(page);

  // Sale 1, keyboard only: search, add, bump quantity to 3 packs, take payment.
  await page.keyboard.press("F2");
  await page.keyboard.type("paracetamol");
  await page.keyboard.press("Enter");
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  // Earliest expiry first, each batch at its own price: 2 packs @ 250 (old batch) + 1 pack @ 270.
  await expect(page.locator(".cart-row small")).toHaveText("2 packs @ 250.00 (B:E2E-OLD) + 1 pack @ 270.00 (B:E2E-NEW)");
  await expect(page.locator(".totals strong.grand")).toHaveText("PKR 770.00");

  // A discount above the cashier's 5% limit is refused.
  await page.keyboard.press("F8");
  await page.keyboard.type("50%");
  await page.keyboard.press("Enter");
  await expect(page.getByText("over your 5% limit")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("F10");
  await page.getByLabel("Cash received").fill("1000");
  await expect(page.locator(".payment-change strong")).toHaveText("PKR 230.00");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("change PKR 230.00");
  const firstReceipt = (await notice(page).textContent())!.match(/Receipt (\S+)/)![1];

  // Print the receipt.
  await page.keyboard.press("Control+p");
  await expect.poll(() => page.evaluate(() => (window as unknown as { prints: number }).prints)).toBe(1);
  await expect(page.locator(".print-area")).toContainText(firstReceipt);
  await expect(page.locator(".print-area")).toContainText("770.00");
  await expect(page.locator(".sync-pill")).toContainText("Offline");

  // Void sale 1 offline: stock goes back.
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  await page.keyboard.type("Wrong strength");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText(`Receipt ${firstReceipt} voided`);

  // Sale 2 offline, then return it.
  await page.keyboard.press("F2");
  await page.keyboard.type("panadol");
  await expect(page.locator(".results")).toContainText("7 packs");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F10");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("PKR 250.00");
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Enter");
  await page.keyboard.press("r");
  await page.locator(".return-table input").first().fill("1");
  await page.getByPlaceholder("Reason (required)").fill("Customer had it at home");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Refund PKR 250.00 by cash");
  await expect(page.locator(".sync-pill")).toContainText("to upload");

  // Restart the app while still offline: nothing is lost and the cashier can sign in offline.
  await page.reload();
  await signInCashier(page);
  await expect(page.getByLabel("Search")).toBeFocused();
  await expect(page.locator(".sync-pill")).toContainText("Offline · 4 to upload");
  await page.keyboard.press("Control+r");
  await expect(page.locator(".pick-list button")).toHaveCount(2);
  await page.keyboard.press("Escape");

  // The internet comes back: everything uploads.
  await restoreInternet(page);
  await page.locator(".sync-pill").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sync-pill")).toHaveText("Online", { timeout: 30_000 });

  // The server has each sale exactly once, with the void and the return applied.
  const login = await request.post(`${API}/api/v1/auth/login`, { data: { login: "e2e-pos-owner@test.local", credential: "e2e-password-123" } });
  expect(login.ok()).toBe(true);
  const sales = await (await request.get(`${API}/api/v1/sales?branchId=${BRANCH}`)).json() as { sales: Array<{ status: string; total: number }> };
  expect(sales.sales.map((sale) => [sale.status, sale.total]).sort()).toEqual([["returned", 250], ["voided", 770]]);
  const catalogue = await (await request.get(`${API}/api/v1/catalogue?branchId=${BRANCH}&q=panadol`)).json() as { products: Array<{ stockQuantity: number }> };
  expect(catalogue.products[0].stockQuantity).toBe(700);
});
