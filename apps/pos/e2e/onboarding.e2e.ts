import { expect, test } from "@playwright/test";

const API = "http://localhost:4000";
const ADMIN_WEB = "http://localhost:3001";
const OWNER_WEB = "http://localhost:3000";
const OWNER_LOGIN = "e2e-onboarded-owner@test.local";

// A Pharmica admin onboards a new pharmacy; its owner takes over with their own password and adds a cashier;
// the counter is set up with its name and the cashier's PIN; the admin records the first payment and the owner sees it.
test("a new pharmacy is created, its counter set up, and paid for end to end", async ({ browser, request }) => {
  // 1. Admin panel: create the pharmacy.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await admin.goto(ADMIN_WEB);
  await admin.getByLabel("Login").fill("e2e-admin@test.local");
  await admin.getByRole("textbox", { name: /^Password/ }).fill("e2e-admin-password");
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin.getByRole("heading", { name: "Platform overview" })).toBeVisible();
  await admin.getByRole("link", { name: "Pharmacies" }).click();
  await admin.getByRole("button", { name: "New pharmacy" }).click();
  await admin.getByLabel("Pharmacy name").fill("E2E Onboarded Pharmacy");
  await admin.getByLabel("Contact person").fill("Sana");
  await admin.getByLabel("City").fill("Lahore");
  await admin.getByLabel("Owner name").fill("Sana Malik");
  await admin.getByLabel("Owner login (email or phone)").fill(OWNER_LOGIN);
  await admin.getByLabel("Plan").selectOption("starter");
  await admin.getByRole("button", { name: "Create pharmacy" }).click();
  await expect(admin.getByText("E2E Onboarded Pharmacy is ready")).toBeVisible();
  const temporaryPassword = (await admin.locator("code.secret").textContent())!.trim();
  const shopCode = (await admin.locator(".created dd code").nth(2).textContent())!.trim();
  expect(shopCode).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
  await expect(admin.locator(".created")).toContainText(`${shopCode}-1`);
  expect(temporaryPassword).toMatch(/^\w{4}-\w{4}-\w{4}$/);

  // 2. Owner panel: first sign-in forces a new password.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto(OWNER_WEB);
  await owner.getByLabel("Login").fill(OWNER_LOGIN);
  await owner.getByRole("textbox", { name: /^Password/ }).fill(temporaryPassword);
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.getByLabel("Temporary password").fill(temporaryPassword);
  await owner.getByLabel("New password", { exact: true }).fill("sana-own-password-1");
  await owner.getByLabel("New password again").fill("sana-own-password-1");
  await owner.getByRole("button", { name: "Save password" }).click();
  await expect(owner.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Subscription", exact: true }).click();
  await expect(owner.locator(".metrics")).toContainText("Free trial");

  // The owner adds a cashier with a PIN (through the API, as the staff page does).
  await request.post(`${API}/api/v1/auth/login`, { data: { login: OWNER_LOGIN, credential: "sana-own-password-1" } });
  const branches = await (await request.get(`${API}/api/v1/branches`)).json() as { branches: Array<{ id: string }> };
  expect((await request.post(`${API}/api/v1/users`, { data: { name: "Onboard Cashier", login: "e2e-onboard-cashier", role: "cashier", branchId: branches.branches[0].id, pin: "2468" } })).status()).toBe(201);

  // The owner sees the shop ID in the sidebar.
  await expect(owner.locator(".shop-id")).toContainText(shopCode);

  // 3. The counter is set up with its name and the cashier's PIN, which signs the cashier in.
  const posContext = await browser.newContext({ baseURL: "http://localhost:3002" });
  const pos = await posContext.newPage();
  await pos.goto("/");
  await pos.getByLabel("Counter name").fill(`${shopCode}-1`);
  await pos.getByLabel("Your PIN").fill("2468");
  await pos.keyboard.press("Enter");
  await expect(pos.locator(".signed-in")).toContainText("Onboard Cashier");

  // 4. Admin: the checklist moved on; record the first payment.
  await admin.getByRole("button", { name: "Open pharmacy" }).click();
  await expect(admin.locator(".checklist li.done")).toContainText(["Owner signed in", "A counter is linked", "Counter staff have PINs"]);
  await admin.getByRole("button", { name: "Subscription" }).click();
  await admin.getByRole("button", { name: "Issue invoice" }).click();
  await expect(admin.getByText("Renewal invoice issued")).toBeVisible();
  await admin.getByPlaceholder(/Amount/).fill("3000");
  await admin.getByPlaceholder("Receipt number or bank reference").fill("RB-E2E-1");
  await admin.getByRole("button", { name: "Record payment" }).click();
  await expect(admin.getByText(/Payment of PKR 3,000 recorded/)).toBeVisible();
  await expect(admin.locator(".head-side")).toContainText("Active");

  // The owner sees the payment and its receipt number.
  await owner.reload();
  await owner.getByRole("button", { name: "Subscription", exact: true }).click();
  await expect(owner.locator(".metrics")).toContainText("Active");
  await expect(owner.getByRole("cell", { name: "RB-E2E-1" })).toBeVisible();

  await Promise.all([adminContext.close(), ownerContext.close(), posContext.close()]);
});
