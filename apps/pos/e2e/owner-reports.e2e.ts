import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const API = "http://localhost:4000";
const OWNER_WEB = "http://localhost:3000";
const BRANCH = "e2e-pos-branch";

// The owner signs in to the web panel, records an expense, finds it in profit and loss, changes the receipt
// footer that counters print, and exports the shop's data without any secret in it.
test("owner dashboard, expenses, profit and loss, settings, and export", async ({ page, request }) => {
  await page.goto(OWNER_WEB);
  await page.getByLabel("Login").fill("e2e-pos-owner@test.local");
  await page.getByLabel("Password").fill("e2e-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Sales today")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last 7 days" })).toBeVisible();

  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await page.locator("form select").first().selectOption("Rent");
  await page.getByPlaceholder("Amount (PKR)").fill("1234");
  await page.getByPlaceholder("Note (optional)").fill("E2E rent");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".page-note")).toContainText("Rent PKR 1,234.00 recorded");
  await expect(page.getByRole("cell", { name: "E2E rent" })).toBeVisible();

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("button", { name: "Profit & loss" }).click();
  const rent = page.getByRole("row", { name: /Expense: Rent/ });
  await expect(rent).toContainText("PKR 1,234.00");
  await expect(page.getByRole("row", { name: /Net profit/ })).toBeVisible();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await page.getByLabel("Group by").selectOption("company");
  await expect(page.locator(".report-covers")).toContainText("Sales by company");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Receipt footer").fill("E2E footer: thank you");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".page-note")).toContainText("Saved");
  await request.post(`${API}/api/v1/auth/login`, { data: { login: "e2e-pos-owner@test.local", credential: "e2e-password-123" } });
  const branches = await (await request.get(`${API}/api/v1/branches`)).json() as { branches: Array<{ id: string; settings: { receiptFooter: string } }> };
  expect(branches.branches.find((branch) => branch.id === BRANCH)?.settings.receiptFooter).toBe("E2E footer: thank you");

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download everything (JSON)" }).click();
  const download = await downloading;
  const text = readFileSync(await download.path(), "utf8");
  for (const secret of ["credentialHash", "pinHash", "secretHash", "activationCode", "E2EPOSCODE01"]) expect(text).not.toContain(secret);
  const data = JSON.parse(text) as { expenses: Array<{ note: string; amount: string }> };
  expect(data.expenses).toContainEqual(expect.objectContaining({ note: "E2E rent", amount: "1234" }));

  // Remove the expense again so other scenarios see clean books.
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("row", { name: /E2E rent/ }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No expenses in this period.")).toBeVisible();
});
