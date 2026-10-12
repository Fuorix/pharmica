import { useState } from "react";
import { CataloguePage } from "./CataloguePage";
import { CollectionsPage } from "./CollectionsPage";
import { OverviewPage } from "./OverviewPage";
import { PlansPage } from "./PlansPage";
import { useAdminSession } from "./session";
import { TenantDetailPage } from "./TenantDetailPage";
import { TenantsPage } from "./TenantsPage";

export type Section = "overview" | "tenants" | "catalogue" | "collections" | "plans";

const SECTIONS: Array<[Section, string]> = [["overview", "Overview"], ["tenants", "Pharmacies"], ["catalogue", "Catalogue"], ["collections", "Collections"], ["plans", "Plans"]];

export function App() {
  const { user, signOut } = useAdminSession();
  const [section, setSection] = useState<Section>("overview");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const go = (next: Section) => { setSection(next); setTenantId(null); };

  return <main className="admin-shell">
    <aside>
      <div className="mark">P</div>
      <p className="eyebrow">PHARMICA OPS</p>
      <h1>Control room</h1>
      <nav>{SECTIONS.map(([key, label]) => <a key={key} href={`#${key}`} className={section === key ? "active" : ""} onClick={(event) => { event.preventDefault(); go(key); }}>{label}</a>)}</nav>
      <div className="account"><span>{user.name}</span><button onClick={signOut}>Sign out</button></div>
    </aside>
    <section className="workspace">
      {tenantId ? <TenantDetailPage id={tenantId} onBack={() => setTenantId(null)} />
        : section === "overview" ? <OverviewPage go={go} />
        : section === "tenants" ? <TenantsPage />
        : section === "catalogue" ? <CataloguePage />
        : section === "collections" ? <CollectionsPage openTenant={setTenantId} />
        : <PlansPage />}
    </section>
  </main>;
}
