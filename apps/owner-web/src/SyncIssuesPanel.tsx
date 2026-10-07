import { useCallback, useEffect, useState } from "react";
import type { SyncIssue } from "@pharmica/contracts";
import { apiFetch, errorMessage, jsonBody } from "./session";

const flagText: Record<string, string> = {
  OVERSOLD: "Two counters sold the same stock while offline; count this item",
  DISCOUNT_OVER_LIMIT: "Discount above the cashier's limit",
  CREDIT_LIMIT_EXCEEDED: "Credit sale over the customer's limit",
  CONTROLLED_WITHOUT_PRESCRIPTION: "Controlled drug sold without a prescription in the register",
  TOTAL_MISMATCH: "Bill total did not add up",
  DUPLICATE_PHONE: "Customer added with a phone number already in use",
  ADJUSTED_TO_AVAILABLE: "Write-off was larger than the stock left"
};
const describe = (flag: string) => flagText[flag] ?? flag.replace(/^NOTE: /, "");

/**
 * Counter uploads the owner should look at: rejected by the server, still being retried, or accepted with a
 * warning. Each can be marked as reviewed with a note.
 */
export function SyncIssuesPanel({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!branchId) return;
    const response = await apiFetch(`/api/v1/sync/issues?branchId=${branchId}${showAll ? "&state=all" : ""}`);
    if (response.ok) setIssues((await response.json()).issues);
  }, [branchId, showAll]);
  useEffect(() => { void load(); }, [load]);

  async function review(issue: SyncIssue) {
    const note = window.prompt("What did you do about it? (optional)", "");
    if (note === null) return;
    const response = await apiFetch("/api/v1/sync/issues", { method: "PATCH", ...jsonBody({ operationId: issue.id, note: note || undefined }) });
    setMessage(response.ok ? "Marked as reviewed" : await errorMessage(response, "Could not save"));
    if (response.ok) await load();
  }

  return <article className="panel sync-issues">
    <div className="panel-heading">
      <h2>Sync issues</h2>
      <span className="row-actions">
        {branches.length > 1 && <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
        <label className="check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Show reviewed</label>
      </span>
    </div>
    <p className="page-note">{message || "Counters keep selling while offline. When their work reaches Pharmica, anything that could not be applied, or that needs your attention, appears here."}</p>
    {issues.map((issue) => <div className={`staff-row issue ${issue.status}`} key={issue.id}>
      <div>
        <strong>{issue.summary}</strong>
        <span>{issue.deviceName}{issue.userName ? ` · ${issue.userName}` : ""}{issue.occurredAt ? ` · ${new Date(issue.occurredAt).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}` : ""}</span>
        <span className="issue-detail">{issue.status === "rejected" ? `Not applied: ${issue.error ?? "rejected"}` : issue.status === "retrying" ? "Still being retried by the counter" : issue.flags.map(describe).join("; ")}</span>
        {issue.reviewedAt && <span>Reviewed by {issue.reviewedBy}{issue.reviewNote ? `: ${issue.reviewNote}` : ""}</span>}
      </div>
      {!issue.reviewedAt && <button className="secondary" onClick={() => void review(issue)}>Mark reviewed</button>}
    </div>)}
    {!issues.length && <p className="page-note">Nothing needs your attention.</p>}
  </article>;
}
