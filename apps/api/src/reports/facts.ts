import type { PaymentMethod } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { roundMoney, splitAmount } from "@pharmica/domain";
import { pkDay, type Period } from "./period";

/**
 * One line of trade, the unit every sales and profit figure is built from. A sale line counts on the day it was
 * sold; a return counts (negatively) on the day it came back. Voided sales do not count at all.
 */
export interface SaleFact {
  kind: "sale" | "return";
  at: Date;
  day: string;
  branchId: string;
  saleId: string;
  productId: string;
  productName: string;
  company: string;
  cashierId: string;
  cashierName: string;
  paymentMethod: PaymentMethod;
  /** Money received after all discounts (line and its share of the bill discount); negative for returns. */
  revenue: number;
  /** Discount given on this line, including its share of the bill discount; negative for returns. */
  discount: number;
  /** What the goods cost the shop; null when the cost of an early sale is unknown. */
  cost: number | null;
}

const lower = (value: string) => value.toLowerCase() as PaymentMethod;

export async function saleFacts(branchIds: string[], period: Period): Promise<SaleFact[]> {
  const productInclude = { product: { select: { name: true, company: true, masterProduct: { select: { name: true, company: true } } } } } as const;
  const [sales, returns] = await Promise.all([
    db.sale.findMany({
      where: { branchId: { in: branchIds }, createdAt: { gte: period.from, lt: period.to }, status: { not: "VOIDED" } },
      include: { lines: { include: productInclude }, user: { select: { name: true } } }
    }),
    db.saleReturn.findMany({
      where: { branchId: { in: branchIds }, createdAt: { gte: period.from, lt: period.to } },
      include: { user: { select: { name: true } }, sale: { select: { paymentMethod: true } }, lines: { include: { saleLine: { include: productInclude } } } }
    })
  ]);

  const facts: SaleFact[] = [];
  for (const sale of sales) {
    // The bill discount is shared over lines in proportion to their totals, so each line's revenue adds up to the bill.
    const lineTotals = sale.lines.map((line) => Number(line.lineTotal));
    const billDiscount = roundMoney(lineTotals.reduce((sum, total) => sum + total, 0) - Number(sale.total));
    const shares = splitAmount(Math.max(0, billDiscount), lineTotals);
    sale.lines.forEach((line, index) => {
      const product = line.product.masterProduct ?? line.product;
      facts.push({
        kind: "sale", at: sale.createdAt, day: pkDay(sale.createdAt), branchId: sale.branchId, saleId: sale.id, productId: line.productId,
        productName: product.name, company: product.company ?? "Other",
        cashierId: sale.userId, cashierName: sale.user.name, paymentMethod: lower(sale.paymentMethod),
        revenue: roundMoney(lineTotals[index] - shares[index]),
        discount: roundMoney(Number(line.discount) + shares[index]),
        cost: line.unitCost == null ? null : roundMoney(Number(line.unitCost) * line.quantity)
      });
    });
  }
  for (const saleReturn of returns) {
    for (const item of saleReturn.lines) {
      const line = item.saleLine;
      const product = line.product.masterProduct ?? line.product;
      facts.push({
        kind: "return", at: saleReturn.createdAt, day: pkDay(saleReturn.createdAt), branchId: saleReturn.branchId, saleId: saleReturn.saleId, productId: line.productId,
        productName: product.name, company: product.company ?? "Other",
        cashierId: saleReturn.userId, cashierName: saleReturn.user.name, paymentMethod: lower(saleReturn.sale.paymentMethod),
        revenue: -Number(item.amount),
        discount: 0,
        cost: line.unitCost == null ? null : -roundMoney(Number(line.unitCost) * item.quantity)
      });
    }
  }
  return facts.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface Totals {
  revenue: number;
  /** Cost of the goods whose cost is known. */
  cost: number;
  /** Revenue minus cost, over lines whose cost is known. */
  grossProfit: number;
  /** Gross profit as a percent of the revenue it was earned on; null when nothing had a known cost. */
  marginPercent: number | null;
  discounts: number;
  returns: number;
  /** Revenue on lines whose cost is unknown (early sales), left out of profit. */
  revenueWithoutCost: number;
  bills: number;
}

export function totalsOf(facts: SaleFact[]): Totals {
  const costed = facts.filter((fact) => fact.cost !== null);
  const revenue = roundMoney(facts.reduce((sum, fact) => sum + fact.revenue, 0));
  const costedRevenue = roundMoney(costed.reduce((sum, fact) => sum + fact.revenue, 0));
  const cost = roundMoney(costed.reduce((sum, fact) => sum + fact.cost!, 0));
  return {
    revenue,
    cost,
    grossProfit: roundMoney(costedRevenue - cost),
    marginPercent: costedRevenue > 0 ? Math.round((costedRevenue - cost) / costedRevenue * 1000) / 10 : null,
    discounts: roundMoney(facts.reduce((sum, fact) => sum + fact.discount, 0)),
    returns: roundMoney(-facts.filter((fact) => fact.kind === "return").reduce((sum, fact) => sum + fact.revenue, 0)),
    revenueWithoutCost: roundMoney(revenue - costedRevenue),
    bills: new Set(facts.filter((fact) => fact.kind === "sale").map((fact) => fact.saleId)).size
  };
}

export type GroupBy = "day" | "product" | "company" | "cashier" | "payment" | "branch";

/** Totals grouped by one dimension, biggest revenue first (by date for days). */
export function groupFacts(facts: SaleFact[], groupBy: GroupBy, branchNames: Map<string, string>): Array<{ key: string; label: string } & Totals> {
  const keyOf = (fact: SaleFact): [string, string] => {
    switch (groupBy) {
      case "day": return [fact.day, fact.day];
      case "product": return [fact.productId, fact.productName];
      case "company": return [fact.company, fact.company];
      case "cashier": return [fact.cashierId, fact.cashierName];
      case "payment": return [fact.paymentMethod, fact.paymentMethod];
      case "branch": return [fact.branchId, branchNames.get(fact.branchId) ?? fact.branchId];
    }
  };
  const groups = new Map<string, { label: string; facts: SaleFact[] }>();
  for (const fact of facts) {
    const [key, label] = keyOf(fact);
    const group = groups.get(key) ?? { label, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  }
  const rows = [...groups.entries()].map(([key, group]) => ({ key, label: group.label, ...totalsOf(group.facts) }));
  return groupBy === "day" ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows.sort((a, b) => b.revenue - a.revenue);
}
