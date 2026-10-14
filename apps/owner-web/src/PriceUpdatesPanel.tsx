import { useState } from "react";
import type { PriceUpdate } from "@pharmica/contracts";
import { money, shortDate } from "./accountsUi";
import { useReport } from "./reportsUi";
import { apiFetch, errorMessage, jsonBody } from "./session";

/**
 * Official (DRAP / company) price changes for medicines this branch stocks. The owner can follow the new price or
 * keep selling lower with a shop price; a shop price can never go above the price printed on the batch.
 */
export function PriceUpdatesPanel({ branchId, onChanged }: { branchId: string; onChanged: () => void }) {
  const { data, reload } = useReport<{ updates: PriceUpdate[] }>(`/api/v1/catalogue/price-updates?branchId=${branchId}&days=60`);
  const [message, setMessage] = useState("");
  const updates = data?.updates ?? [];

  async function setShopPrice(update: PriceUpdate, price: number | null, done: string) {
    const response = await apiFetch("/api/v1/catalogue", { method: "PATCH", ...jsonBody({ productId: update.productId, retailPriceOverride: price }) });
    setMessage(response.ok ? done : await errorMessage(response, "Could not change the price"));
    if (response.ok) { await reload(); onChanged(); }
  }

  if (!updates.length) return null;
  return <article className="panel price-updates">
    <div className="panel-heading"><h2>Official price changes ({updates.length})</h2><span>{message || "Last 60 days and scheduled"}</span></div>
    <table className="detail-table"><thead><tr><th>Medicine</th><th>Was</th><th>New price</th><th>From</th><th>Source</th><th>Your shop price</th><th>Old-price packs on shelf</th><th /></tr></thead><tbody>
      {updates.map((update) => <tr key={update.productId}>
        <td>{update.name}</td>
        <td>{update.oldPrice === null ? "—" : money(update.oldPrice)}</td>
        <td><strong>{money(update.newPrice)}</strong>{update.oldPrice !== null && <small className={update.newPrice > update.oldPrice ? "warning" : ""}>{update.newPrice > update.oldPrice ? "▲" : "▼"} {money(Math.abs(update.newPrice - update.oldPrice))}</small>}</td>
        <td>{shortDate(update.effectiveFrom)}{update.scheduled && <small>Scheduled</small>}</td>
        <td>{update.source}{update.reference && <small>{update.reference}</small>}</td>
        <td>{update.shopPrice === null ? "Follows batch price" : money(update.shopPrice)}</td>
        <td className={update.packsAtOtherPrices ? "warning" : ""}>{update.packsAtOtherPrices || "—"}</td>
        <td className="row-actions">
          {update.shopPrice !== null && <button className="secondary" onClick={() => void setShopPrice(update, null, `${update.name} follows the batch price again`)}>Follow official price</button>}
          <button className="secondary" onClick={() => {
            const value = window.prompt(`Shop price per pack for ${update.name} (cannot be above the batch price). Leave empty to follow the batch price.`, update.shopPrice === null ? "" : String(update.shopPrice));
            if (value === null) return;
            const price = value.trim() === "" ? null : Number(value);
            if (price !== null && (!Number.isFinite(price) || price <= 0)) return setMessage("Enter a price above zero");
            void setShopPrice(update, price, price === null ? `${update.name} follows the batch price` : `${update.name} sells at ${money(price)}`);
          }}>Set shop price</button>
        </td>
      </tr>)}
    </tbody></table>
  </article>;
}
