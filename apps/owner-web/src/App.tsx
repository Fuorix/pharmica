import { useCallback, useEffect, useState } from "react";
import { CataloguePage } from "./CataloguePage";
import { CustomersPage } from "./CustomersPage";
import { DashboardPage } from "./DashboardPage";
import { ExpensesPage } from "./ExpensesPage";
import { ImportWizard } from "./ImportWizard";
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

type Page = "dashboard" | "reports" | "expenses" | "inventory" | "purchases" | "suppliers" | "catalogue" | "customers" | "register" | "staff" | "settings" | "subscription" | "import";

const NAV: Array<{ group: string; pages: Array<[Page, string]> }> = [
  { group: "Daily", pages: [["dashboard", "Today"], ["reports", "Reports"], ["expenses", "Expenses"]] },
  { group: "Stock", pages: [["inventory", "Inventory"], ["purchases", "Purchases"], ["suppliers", "Suppliers"], ["catalogue", "Catalogue"]] },
  { group: "People", pages: [["customers", "Customers"], ["staff", "Staff & devices"]] },
  { group: "Records", pages: [["register", "Register"], ["import", "Import data"]] },
  { group: "Account", pages: [["settings", "Settings"], ["subscription", "Subscription"]] }
];

/** Simple line icons (24px grid) so each page is recognisable without reading. */
const ICONS: Record<Page, string> = {
  dashboard: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  expenses: "M3 6h18v12H3zM3 10h18M7 15h3",
  inventory: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  purchases: "M3 4h2l2.5 11h11L21 8H7M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01",
  suppliers: "M2 7h11v9H2zM13 10h4l4 3v3h-8M6 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01",
  catalogue: "M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM8 9h8M8 13h6",
  customers: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6",
  staff: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 15c2 .6 3.4 2.2 4 5",
  register: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  import: "M12 3v12M7 10l5 5 5-5M4 21h16",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  subscription: "M3 6h18v12H3zM3 10h18M15 15h3"
};
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

  return <div className="app">
    <aside className="sidebar no-print">
      <div className="brand"><span className="brand-mark" aria-hidden="true">+</span><div><strong>Pharmica</strong><small>Owner panel</small></div></div>
      {page !== "staff" && branches.length > 1 && <select className="branch-select" aria-label="Branch" value={canShowAll && allBranches ? "all" : branchId} onChange={(event) => {
        if (event.target.value === "all") return setAllBranches(true);
        setAllBranches(false);
        setBranchId(event.target.value);
      }}>
        {canShowAll && <option value="all">All branches</option>}
        {branches.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>}
      <nav className="side-nav" aria-label="Pages">
        {NAV.map(({ group, pages }) => <div key={group} className="nav-group"><p>{group}</p>
          {pages.map(([value, label]) => <button key={value} className={page === value ? "nav-item active" : "nav-item"} aria-current={page === value ? "page" : undefined} onClick={() => setPage(value)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[value]} /></svg>{label}
          </button>)}
        </div>)}
      </nav>
      <div className="side-account"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="who">{user.name}</span><button className="secondary" onClick={signOut}>Sign out</button></div>
    </aside>
    <main className="shell">
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
    {page === "import" && branches.length > 0 && <><div className="page-heading"><h1>Import data</h1></div><ImportWizard branches={branches} /></>}
    </main>
  </div>;
}
