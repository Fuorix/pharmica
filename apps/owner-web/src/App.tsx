import { useEffect, useState } from "react";
import { CataloguePage } from "./CataloguePage";
import { CustomersPage } from "./CustomersPage";
import { PurchasesPage } from "./PurchasesPage";
import { RegisterPage } from "./RegisterPage";
import { SuppliersPage } from "./SuppliersPage";
import { InventoryPage } from "./InventoryPage";
import { apiFetch, useOwnerSession } from "./session";
import { StaffPage } from "./StaffPage";

type Branch = { id: string; name: string };
type Page = "inventory" | "purchases" | "suppliers" | "catalogue" | "customers" | "register" | "staff";

export function App() {
  const { user, signOut } = useOwnerSession();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [page, setPage] = useState<Page>("inventory");

  useEffect(() => {
    apiFetch("/api/v1/branches").then(async (response) => {
      if (!response.ok) return;
      const loaded = (await response.json()).branches as Branch[];
      setBranches(loaded);
      setBranchId((current) => current || loaded[0]?.id || "");
    }).catch(() => undefined);
  }, []);

  return <main className="shell">
    <header className="no-print">
      <div><p className="eyebrow">PHARMICA OWNER</p>
        <nav className="tabs">
          <button className={page === "inventory" ? "tab active" : "tab"} onClick={() => setPage("inventory")}>Inventory</button>
          <button className={page === "purchases" ? "tab active" : "tab"} onClick={() => setPage("purchases")}>Purchases</button>
          <button className={page === "suppliers" ? "tab active" : "tab"} onClick={() => setPage("suppliers")}>Suppliers</button>
          <button className={page === "catalogue" ? "tab active" : "tab"} onClick={() => setPage("catalogue")}>Catalogue</button>
          <button className={page === "customers" ? "tab active" : "tab"} onClick={() => setPage("customers")}>Customers</button>
          <button className={page === "register" ? "tab active" : "tab"} onClick={() => setPage("register")}>Register</button>
          <button className={page === "staff" ? "tab active" : "tab"} onClick={() => setPage("staff")}>Staff & devices</button>
        </nav>
      </div>
      <div className="account">
        {page !== "staff" && branches.length > 1 && <select aria-label="Branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
        <span>{user.name}</span>
        <button className="secondary" onClick={signOut}>Sign out</button>
      </div>
    </header>
    {page === "inventory" && branchId && <InventoryPage branchId={branchId} />}
    {page === "purchases" && branchId && <PurchasesPage branchId={branchId} />}
    {page === "catalogue" && branchId && <CataloguePage branchId={branchId} />}
    {page === "suppliers" && branchId && <SuppliersPage branchId={branchId} />}
    {page === "customers" && branchId && <CustomersPage branchId={branchId} />}
    {page === "register" && branchId && <RegisterPage branchId={branchId} />}
    {page === "staff" && branches.length > 0 && <StaffPage branches={branches} />}
  </main>;
}
