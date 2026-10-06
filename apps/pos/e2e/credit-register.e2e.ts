import { expect, test, type Page } from "@playwright/test";

const API = "http://localhost:4000";
const BRANCH = "e2e-pos-branch";
const notice = (page: Page) => page.getByRole("status");

test("a counter sells on credit, takes a repayment, and records a controlled drug in the register, all offline", async ({ page, request }) => {
  await page.addInitScript(() => { window.print = () => undefined; });
  await page.goto("/");
  await page.getByLabel("Activation code").fill("E2EPOSCODE03");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Who is at the counter?")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("1");
  await page.getByLabel("PIN for E2E Cashier").fill("1234");
  await page.keyboard.press("Enter");
  await page.getByLabel("Opening cash (PKR)").fill("1000");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Shift opened");

  await page.route(`${API}/**`, (route) => route.abort("internetdisconnected"));

  // A new customer, added at the counter while offline, buys on credit (udhaar).
  await page.keyboard.press("F3");
  await page.keyboard.press("Control+n");
  await page.getByPlaceholder("Name").fill("E2E Khata Customer");
  await page.getByPlaceholder("Credit limit in PKR (empty = no credit)").fill("5000");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(notice(page)).toContainText("Customer: E2E Khata Customer");
  await page.keyboard.type("arinac");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F9");
  await page.keyboard.press("F9");
  await page.keyboard.press("F10");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("PKR 310.00");

  // The customer pays back part of it.
  await page.keyboard.press("F3");
  await page.getByPlaceholder("Search by name or mobile").fill("khata");
  await expect(page.locator(".pick-list")).toContainText("owes PKR 310.00");
  await page.getByRole("button", { name: /Receive payment from/ }).click();
  await page.getByLabel("Amount received").fill("100");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Still owed: PKR 210.00");

  // A controlled drug cannot be sold until the prescription is entered.
  await page.keyboard.press("F2");
  await page.keyboard.type("xanax");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F10");
  await expect(page.getByRole("dialog", { name: "Narcotics register" })).toBeVisible();
  await page.getByLabel("Patient name").fill("Ahmed Raza");
  await page.getByLabel("Doctor name").fill("Dr. Saima Khan");
  await page.getByLabel("Doctor PMDC / registration no.").fill("PMDC-12345");
  await page.getByLabel("Prescription no. / reference").fill("RX-889");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Take payment" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Receipt");

  // The drawer expects the opening cash, the cash sale, and the cash repayment.
  await page.keyboard.press("F11");
  await expect(page.locator(".report-grid")).toContainText("Credit repaid (cash / card)PKR 100.00 / PKR 0.00");
  await expect(page.locator(".report-grid .emphasis")).toContainText("PKR 1,430.00");
  await page.keyboard.press("Escape");

  // Back online: the khata and the register reach the server.
  await page.unroute(`${API}/**`);
  await page.locator(".sync-pill").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sync-pill")).toHaveText("Online", { timeout: 30_000 });

  await request.post(`${API}/api/v1/auth/login`, { data: { login: "e2e-pos-owner@test.local", credential: "e2e-password-123" } });
  const customers = await (await request.get(`${API}/api/v1/customers?branchId=${BRANCH}&status=owing`)).json() as { customers: Array<{ name: string; balance: number }> };
  expect(customers.customers).toEqual([expect.objectContaining({ name: "E2E Khata Customer", balance: 210 })]);
  const register = await (await request.get(`${API}/api/v1/controlled-drugs?branchId=${BRANCH}`)).json() as { entries: Array<Record<string, unknown>> };
  expect(register.entries).toEqual([expect.objectContaining({ entryType: "ENTRY", productName: "Xanax 0.5mg", quantity: 1, patientName: "Ahmed Raza", doctorName: "Dr. Saima Khan", doctorRegNo: "PMDC-12345", prescriptionRef: "RX-889", recordedBy: "E2E Cashier" })]);
});
