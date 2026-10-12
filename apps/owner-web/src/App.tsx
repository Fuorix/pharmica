import { useCallback, useEffect, useState } from "react";
import { CataloguePage } from "./CataloguePage";
import { CustomersPage } from "./CustomersPage";
import { DashboardPage } from "./DashboardPage";
import { ExpensesPage } from "./ExpensesPage";
import { PurchasesPage } from "./PurchasesPage";
import { RegisterPage } from "./RegisterPage";
import { ReportsPage } from "./ReportsPage";
import { SettingsPage, type BranchDetails } from "./SettingsPage";
import { SubscriptionPage, subscriptionNotice } from "./SubscriptionPage";
import type { BillingOverview } from "@pharmica/contracts";
import { SuppliersPage } from "./SuppliersPage";
import { InventoryPage } from "./InventoryPage";
import { apiFetch, errorMessage, useOwnerSession } from "./session";
import { StaffPage } from "./StaffPage";

type Page = "dashboard" | "reports" | "expenses" | "inventory" | "purchases" | "suppliers" | "catalogue" | "customers" | "register" | "staff" | "settings" | "subscription";

const PAGES: Array<[Page, string]> = [
  ["dashboard", "Today"], ["reports", "Reports"], ["expenses", "Expenses"], ["inventory", "Inventory"], ["purchases", "Purchases"], ["suppliers", "Suppliers"],
  ["catalogue", "Catalogue"], ["customers", "Customers"], ["register", "Register"], ["staff", "Staff & devices"], ["settings", "Settings"], ["subscription", "Subscription"]
];
/** Pages that can show every branch together. */
const ALL_BRANCH_PAGES: Page[] = ["dashboard", "reports", "expenses"];

export function App() {
  const { user, signOut } = useOwnerSession();
  const [branches, setBranches] = useState<BranchDetails[]>([]);
  const [branchId, setBranchId] = useState("");
  const [allBranches, setAllBranches] = useState(true);
  const [page, setPage] = useState<Page>("dashboard");

  const [branchError, setBranchError] = useState("");
  const loadBranches = useCallback(() => {
    apiFetch("/api/v1/branches").then(async (response) => {
      if (!response.ok) return setBranchError(await errorMessage(response, "Could not load your branches"));
      const loaded = (await response.json()).branches as BranchDetails[];
      setBranchError("");
      setBranches(loaded);
      setBranchId((current) => current || loaded[0]?.id || "");
    }).catch(() => setBranchError("Cannot reach Pharmica. Check the internet connection."));
  }, []);
  useEffect(() => { loadBranches(); }, [loadBranches]);

  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const loadBilling = useCallback(() => {
    apiFetch("/api/v1/billing").then(async (response) => { if (response.ok) setBilling(await response.json() as BillingOverview); }).catch(() => undefined);
  }, []);
  useEffect(() => { loadBilling(); }, [loadBilling]);
  const notice = subscriptionNotice(billing?.subscription);

  const canShowAll = ALL_BRANCH_PAGES.includes(page) && branches.length > 1;
  const scope = canShowAll && allBranches ? "all" : branchId;
  const branch = branches.find((candidate) => candidate.id === branchId);

  return <main className="shell">
    <header className="no-print">
      <div><p className="eyebrow">PHARMICA OWNER</p>
        <nav className="tabs">
          {PAGES.map(([value, label]) => <button key={value} className={page === value ? "tab active" : "tab"} onClick={() => setPage(value)}>{label}</button>)}
        </nav>
      </div>
      <div className="account">
        {page !== "staff" && branches.length > 1 && <select aria-label="Branch" value={canShowAll && allBranches ? "all" : branchId} onChange={(event) => {
          if (event.target.value === "all") return setAllBranches(true);
          setAllBranches(false);
          setBranchId(event.target.value);
        }}>
          {canShowAll && <option value="all">All branches</option>}
          {branches.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>}
        <span>{user.name}</span>
        <button className="secondary" onClick={signOut}>Sign out</button>
      </div>
    </header>
    {notice && page !== "subscription" && <p className={`subscription-banner no-print ${notice.tone}`}>{notice.text} <button className="link" onClick={() => setPage("subscription")}>Renew</button></p>}
    {!branchId && page !== "subscription" && <p className="page-note">{branchError ? <>{branchError} <button className="link" onClick={loadBranches}>Try again</button></> : "Loading your pharmacy…"}</p>}
    {page === "dashboard" && scope && <DashboardPage scope={scope} />}
    {page === "reports" && scope && <ReportsPage scope={scope} branchId={branchId} />}
    {page === "expenses" && scope && <ExpensesPage scope={scope} branchId={branchId} branches={branches} />}
    {page === "inventory" && branchId && <InventoryPage branchId={branchId} />}
    {page === "purchases" && branchId && <PurchasesPage branchId={branchId} />}
    {page === "catalogue" && branchId && <CataloguePage branchId={branchId} />}
    {page === "suppliers" && branchId && <SuppliersPage branchId={branchId} />}
    {page === "customers" && branchId && <CustomersPage branchId={branchId} />}
    {page === "register" && branchId && <RegisterPage branchId={branchId} />}
    {page === "staff" && branches.length > 0 && <StaffPage branches={branches} />}
    {page === "settings" && branch && <SettingsPage branch={branch} onSaved={loadBranches} />}
    {page === "subscription" && <SubscriptionPage onChanged={loadBilling} />}
  </main>;
}
