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

/** Simple line icons (24px grid), the same style as the owner panel. */
const ICONS: Record<Section, string> = {
  overview: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  tenants: "M3 21V8l9-5 9 5v13M9 21v-6h6v6M12 8v4M10 10h4",
  catalogue: "M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM8 9h8M8 13h6",
  collections: "M3 6h18v12H3zM3 10h18M15 15h3",
  plans: "M4 6h16M4 12h16M4 18h10"
};

export function App() {
  const { user, signOut } = useAdminSession();
  const [section, setSection] = useState<Section>("overview");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const go = (next: Section) => { setSection(next); setTenantId(null); };

  return <main className="admin-shell">
    <aside>
      <div className="brand"><span className="brand-mark" aria-hidden="true">+</span><div><h1>Pharmica</h1><small>Control room</small></div></div>
      <nav aria-label="Sections">{SECTIONS.map(([key, label]) => <a key={key} href={`#${key}`} className={section === key ? "active" : ""} aria-current={section === key ? "page" : undefined} onClick={(event) => { event.preventDefault(); go(key); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[key]} /></svg>{label}
      </a>)}</nav>
      <div className="account"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="who">{user.name}</span><button className="ghost" onClick={signOut}>Sign out</button></div>
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
