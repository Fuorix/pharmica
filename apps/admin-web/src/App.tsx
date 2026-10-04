import { useAdminSession } from "./session";

const queue = [
  ["Price report", "Nobel Pharma · 14 shops", "Review"],
  ["New tenant", "Al-Madina Medical Store", "Onboard"],
  ["Grace mode", "4 subscriptions overdue", "Collect"]
];

export function App() {
  const { user, signOut } = useAdminSession();
  return <main className="admin-shell"><aside><div className="mark">P</div><p className="eyebrow">PHARMICA OPS</p><h1>Control room</h1><nav><a className="active">Overview</a><a>Tenants</a><a>Catalogue</a><a>Collections</a><a>System health</a></nav><div className="account"><span>{user.name}</span><button onClick={signOut}>Sign out</button></div></aside><section className="workspace"><header><div><p className="eyebrow">WEDNESDAY, 01 OCTOBER 2026</p><h2>Platform overview</h2></div><span className="status">All systems operational</span></header><div className="stats"><div><span>Active shops</span><strong>126</strong></div><div><span>Monthly revenue</span><strong>PKR 2.8m</strong></div><div><span>In grace mode</span><strong>4</strong></div></div><article className="queue"><div className="queue-title"><h3>Work queue</h3><span>3 items</span></div>{queue.map(([title, detail, action]) => <div className="queue-row" key={title}><div><strong>{title}</strong><span>{detail}</span></div><button>{action}</button></div>)}</article></section></main>;
}
