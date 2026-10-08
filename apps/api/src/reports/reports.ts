import type { AlertItem, BranchSettings, CashBookDay, DashboardBranch, DashboardResponse, PriceUpdate, ProfitAndLoss, ShiftSummary, StockHealthItem } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { packStructure, roundMoney, stockStatus, unitSize } from "@pharmica/domain";
import { resolveCurrentPrice } from "../catalogue/master-price";
import { groupFacts, saleFacts, totalsOf } from "./facts";
import { daysOf, periodOf, pkDay, type Period, type ScopeBranch } from "./period";

const DAY_MS = 86_400_000;

export const DEFAULT_SETTINGS: BranchSettings = { receiptHeader: "", receiptFooter: "Medicines are returned only with this receipt.", nearExpiryDays: 90, overdueDays: 30, largeDiscountPercent: 10 };

export function branchSettings(settings: Prisma.JsonValue | null): BranchSettings {
  return { ...DEFAULT_SETTINGS, ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Partial<BranchSettings> : {}) };
}

// ---------- alerts ----------

const ALERT_ACTIONS = ["sale.voided", "sale.void", "sale.returned", "sale.return", "pos.line_deleted", "pos.discount_given", "sale.discount_over_limit", "pos.cash_drawer_opened", "controlled_drug.missing_prescription", "stock.oversold", "stock.write_off", "stock.damage", "stock.expiry", "auth.login_failed"];

/**
 * Things an owner should know about, from the audit log: voids, returns, big discounts, deleted lines, the drawer
 * opened without a sale, controlled drugs without a prescription, oversold stock, write-offs, and repeated failed
 * sign-ins. Newest first.
 */
export async function alerts(branches: ScopeBranch[], period: Period): Promise<AlertItem[]> {
  const ids = branches.map((branch) => branch.id);
  const names = new Map(branches.map((branch) => [branch.id, branch.name]));
  const settings = new Map((await db.branch.findMany({ where: { id: { in: ids } }, select: { id: true, settings: true } })).map((branch) => [branch.id, branchSettings(branch.settings)]));
  const logs = await db.auditLog.findMany({
    where: { action: { in: ALERT_ACTIONS }, createdAt: { gte: period.from, lt: period.to }, OR: [{ branchId: { in: ids } }, { branchId: null, organisationId: branches[0]?.organisationId }] },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 2000
  });

  const items: AlertItem[] = [];
  const failedLogins = new Map<string, typeof logs>();
  for (const log of logs) {
    const meta = (log.metadata ?? {}) as Record<string, unknown>;
    const base = { id: log.id, at: log.createdAt.toISOString(), branchId: log.branchId, branchName: log.branchId ? names.get(log.branchId) ?? null : null, userName: log.user?.name ?? null };
    const amount = (value: unknown) => `PKR ${Number(value ?? 0).toFixed(2)}`;
    switch (log.action) {
      case "sale.voided": case "sale.void": {
        const total = Number(meta.total ?? 0);
        items.push({ ...base, kind: "void", severity: total >= 2000 ? "high" : "medium", description: `Sale voided${meta.total ? ` (${amount(total)})` : ""}: ${meta.reason ?? "no reason"}` });
        break;
      }
      case "sale.returned": case "sale.return":
        items.push({ ...base, kind: "return", severity: "low", description: `Return${meta.refund ? ` of ${amount(meta.refund)}` : ""}: ${meta.reason ?? "no reason"}` });
        break;
      case "pos.discount_given": {
        const percent = Number(meta.subtotal) > 0 ? Number(meta.discount) / Number(meta.subtotal) * 100 : 0;
        const threshold = settings.get(log.branchId ?? "")?.largeDiscountPercent ?? DEFAULT_SETTINGS.largeDiscountPercent;
        if (percent >= threshold) items.push({ ...base, kind: "large_discount", severity: "medium", description: `Discount of ${amount(meta.discount)} (${percent.toFixed(0)}%) on receipt ${meta.receiptNo ?? ""}` });
        break;
      }
      case "sale.discount_over_limit":
        items.push({ ...base, kind: "discount_over_limit", severity: "high", description: `Discount of ${amount(meta.discount)} was over the cashier's ${meta.limit ?? 0}% limit` });
        break;
      case "pos.line_deleted":
        items.push({ ...base, kind: "line_deleted", severity: "low", description: `Removed ${meta.quantity ?? ""} ${meta.unit ?? ""} of ${meta.product ?? "an item"} from a bill` });
        break;
      case "pos.cash_drawer_opened":
        items.push({ ...base, kind: "drawer_opened", severity: "medium", description: "Cash drawer opened without a sale" });
        break;
      case "controlled_drug.missing_prescription":
        items.push({ ...base, kind: "missing_prescription", severity: "high", description: `Controlled drug sold without a prescription in the register: ${(meta.products as string[] | undefined)?.join(", ") ?? ""}` });
        break;
      case "stock.oversold":
        items.push({ ...base, kind: "oversold", severity: "medium", description: "Two counters sold the same stock while offline; count this item" });
        break;
      case "stock.write_off": case "stock.damage": case "stock.expiry":
        items.push({ ...base, kind: "stock_written_off", severity: "low", description: `Stock ${log.action.slice(6).replace("_", " ")}: ${Math.abs(Number(meta.applied ?? meta.requested ?? 0))} units (${meta.reason ?? "no reason"})` });
        break;
      case "auth.login_failed": {
        const key = log.entityId ?? "unknown";
        failedLogins.set(key, [...(failedLogins.get(key) ?? []), log]);
        break;
      }
    }
  }
  for (const [, attempts] of failedLogins) {
    if (attempts.length < 3) continue;
    const latest = attempts[0];
    items.push({ id: latest.id, at: latest.createdAt.toISOString(), kind: "failed_logins", severity: "medium", branchId: latest.branchId, branchName: latest.branchId ? names.get(latest.branchId) ?? null : null, userName: latest.user?.name ?? null, description: `${attempts.length} wrong passwords or PINs` });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- dashboard ----------

/** Cash that should be in each open drawer: opening cash, cash sales, cash repayments, less cash refunds. */
async function cashInOpenShifts(branchId: string): Promise<{ cash: number | null; openShifts: number }> {
  const shifts = await db.shift.findMany({ where: { branchId, status: "OPEN" } });
  if (!shifts.length) return { cash: null, openShifts: 0 };
  let cash = 0;
  for (const shift of shifts) {
    const [sales, repayments, refunds] = await Promise.all([
      db.sale.aggregate({ where: { shiftId: shift.id, paymentMethod: "CASH", status: { not: "VOIDED" } }, _sum: { total: true } }),
      db.customerLedgerEntry.aggregate({ where: { shiftId: shift.id, type: "PAYMENT", paymentMethod: "CASH" }, _sum: { amount: true } }),
      db.saleReturn.aggregate({ where: { refundMethod: "CASH", deviceId: shift.deviceId ?? "none", createdAt: { gte: shift.openedAt } }, _sum: { refundAmount: true } })
    ]);
    cash += Number(shift.openingCash) + Number(sales._sum.total ?? 0) + Number(repayments._sum.amount ?? 0) - Number(refunds._sum.refundAmount ?? 0);
  }
  return { cash: roundMoney(cash), openShifts: shifts.length };
}

export async function dashboard(branches: ScopeBranch[], now = new Date()): Promise<DashboardResponse> {
  const ids = branches.map((branch) => branch.id);
  const today = pkDay(now);
  const weekPeriod = periodOf(pkDay(new Date(now.getTime() - 6 * DAY_MS)), today);
  const [weekFacts, recentAlerts, products, devices] = await Promise.all([
    saleFacts(ids, weekPeriod),
    alerts(branches, periodOf(pkDay(new Date(now.getTime() - 6 * DAY_MS)), today)),
    db.product.findMany({ where: { branchId: { in: ids }, isActive: true }, include: { masterProduct: true, batches: { where: { quantity: { gt: 0 } } } } }),
    db.device.findMany({ where: { branchId: { in: ids }, isActive: true, activatedAt: { not: null } }, select: { branchId: true, diagnostics: true } })
  ]);
  const todayFacts = weekFacts.filter((fact) => fact.day === today);
  const settings = new Map((await db.branch.findMany({ where: { id: { in: ids } }, select: { id: true, settings: true } })).map((branch) => [branch.id, branchSettings(branch.settings)]));

  const rows: DashboardBranch[] = [];
  for (const branch of branches) {
    const branchProducts = products.filter((product) => product.branchId === branch.id);
    const nearDays = settings.get(branch.id)?.nearExpiryDays ?? DEFAULT_SETTINGS.nearExpiryDays;
    const statuses = branchProducts.map((product) => stockStatus(product.batches, { now, unitsPerPack: unitSize("pack", packStructure(product)), lowStockPacks: product.lowStockThreshold, nearExpiryDays: nearDays }));
    const counters = devices.filter((device) => device.branchId === branch.id).map((device) => (device.diagnostics ?? {}) as { pending?: number });
    const drawer = await cashInOpenShifts(branch.id);
    rows.push({
      branchId: branch.id,
      branchName: branch.name,
      today: totalsOf(todayFacts.filter((fact) => fact.branchId === branch.id)),
      cashInDrawer: drawer.cash,
      openShifts: drawer.openShifts,
      lowStock: statuses.filter((status) => status.lowStock).length,
      nearExpiry: statuses.filter((status) => status.nearExpiry > 0).length,
      unsyncedCounters: counters.filter((report) => (report.pending ?? 0) > 0).length,
      pendingUploads: counters.reduce((sum, report) => sum + (report.pending ?? 0), 0)
    });
  }

  const byProduct = groupFacts(todayFacts, "product", new Map());
  return {
    day: today,
    generatedAt: now.toISOString(),
    totals: totalsOf(todayFacts),
    branches: rows,
    topItems: byProduct.slice(0, 5).map((row) => ({ productId: row.key, name: row.label, revenue: row.revenue, grossProfit: row.grossProfit })),
    last7Days: daysOf(weekPeriod).map((day) => {
      const totals = totalsOf(weekFacts.filter((fact) => fact.day === day));
      return { day, revenue: totals.revenue, grossProfit: totals.grossProfit };
    }),
    alerts: recentAlerts.slice(0, 10)
  };
}

// ---------- profit and loss, cash book ----------

/** Cost of stock lost to write-offs, damage, and expiry, valued at each batch's real cost. */
async function stockLosses(ids: string[], period: Period): Promise<number> {
  const movements = await db.stockMovement.findMany({
    where: { branchId: { in: ids }, type: { in: ["WRITE_OFF", "DAMAGE", "EXPIRY"] }, createdAt: { gte: period.from, lt: period.to } },
    include: { batch: { select: { costPrice: true } }, product: { include: { masterProduct: true } } }
  });
  return roundMoney(movements.reduce((sum, movement) => sum + -movement.quantity / unitSize("pack", packStructure(movement.product)) * Number(movement.batch?.costPrice ?? 0), 0));
}

export async function profitAndLoss(branches: ScopeBranch[], period: Period): Promise<ProfitAndLoss> {
  const ids = branches.map((branch) => branch.id);
  const [facts, losses, expenses] = await Promise.all([
    saleFacts(ids, period),
    stockLosses(ids, period),
    db.expense.groupBy({ by: ["category"], where: { branchId: { in: ids }, spentAt: { gte: period.from, lt: period.to } }, _sum: { amount: true } })
  ]);
  const totals = totalsOf(facts);
  const expensesByCategory = expenses.map((row) => ({ category: row.category, amount: Number(row._sum.amount ?? 0) })).sort((a, b) => b.amount - a.amount);
  const expenseTotal = roundMoney(expensesByCategory.reduce((sum, row) => sum + row.amount, 0));
  return {
    from: period.fromDay, to: period.toDay,
    revenue: totals.revenue, costOfGoods: totals.cost, grossProfit: totals.grossProfit,
    stockLosses: losses, expenses: expenseTotal, expensesByCategory,
    netProfit: roundMoney(totals.grossProfit - losses - expenseTotal),
    revenueWithoutCost: totals.revenueWithoutCost
  };
}

/** Cash in and out by day: cash sales and credit repayments in; cash refunds, cash expenses, and cash paid to suppliers out. */
export async function cashBook(branches: ScopeBranch[], period: Period): Promise<CashBookDay[]> {
  const ids = branches.map((branch) => branch.id);
  const range = { gte: period.from, lt: period.to };
  const [sales, repayments, refunds, expenses, supplierPayments] = await Promise.all([
    db.sale.findMany({ where: { branchId: { in: ids }, paymentMethod: "CASH", status: { not: "VOIDED" }, createdAt: range }, select: { total: true, createdAt: true } }),
    db.customerLedgerEntry.findMany({ where: { branchId: { in: ids }, type: "PAYMENT", paymentMethod: "CASH", createdAt: range }, select: { amount: true, createdAt: true } }),
    db.saleReturn.findMany({ where: { branchId: { in: ids }, refundMethod: "CASH", createdAt: range }, select: { refundAmount: true, createdAt: true } }),
    db.expense.findMany({ where: { branchId: { in: ids }, paidFrom: "cash", spentAt: range }, select: { amount: true, spentAt: true } }),
    db.supplierLedgerEntry.findMany({ where: { branchId: { in: ids }, type: "PAYMENT", method: "cash", createdAt: range }, select: { amount: true, createdAt: true } })
  ]);
  const sumBy = (rows: Array<{ at: Date; amount: unknown }>) => {
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(pkDay(row.at), roundMoney((totals.get(pkDay(row.at)) ?? 0) + Number(row.amount)));
    return totals;
  };
  const columns = {
    cashSales: sumBy(sales.map((row) => ({ at: row.createdAt, amount: row.total }))),
    repayments: sumBy(repayments.map((row) => ({ at: row.createdAt, amount: row.amount }))),
    refunds: sumBy(refunds.map((row) => ({ at: row.createdAt, amount: row.refundAmount }))),
    expenses: sumBy(expenses.map((row) => ({ at: row.spentAt, amount: row.amount }))),
    supplierPayments: sumBy(supplierPayments.map((row) => ({ at: row.createdAt, amount: row.amount })))
  };
  return daysOf(period).map((day) => {
    const value = (column: keyof typeof columns) => columns[column].get(day) ?? 0;
    return { day, cashSales: value("cashSales"), repayments: value("repayments"), refunds: value("refunds"), expenses: value("expenses"), supplierPayments: value("supplierPayments"), net: roundMoney(value("cashSales") + value("repayments") - value("refunds") - value("expenses") - value("supplierPayments")) };
  });
}

// ---------- stock health ----------

/**
 * Dead stock (in stock but not sold for `deadDays`) and reorder suggestions (stock lasts fewer than `coverDays`
 * at the last 30 days' rate, or is below the alert level).
 */
export async function stockHealth(branchId: string, options: { now?: Date; deadDays?: number; coverDays?: number } = {}): Promise<StockHealthItem[]> {
  const now = options.now ?? new Date();
  const deadDays = options.deadDays ?? 90;
  const coverDays = options.coverDays ?? 14;
  const products = await db.product.findMany({ where: { branchId, isActive: true }, include: { masterProduct: true, batches: { where: { quantity: { gt: 0 } } } } });
  const sales30 = await db.stockMovement.groupBy({ by: ["productId"], where: { branchId, type: "SALE", createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }, _sum: { quantity: true } });
  const lastSale = await db.stockMovement.groupBy({ by: ["productId"], where: { branchId, type: "SALE" }, _max: { createdAt: true } });
  const sold = new Map(sales30.map((row) => [row.productId, -(row._sum.quantity ?? 0)]));
  const last = new Map(lastSale.map((row) => [row.productId, row._max.createdAt]));

  const items: StockHealthItem[] = [];
  for (const product of products) {
    const perPack = unitSize("pack", packStructure(product));
    const status = stockStatus(product.batches, { now, unitsPerPack: perPack, lowStockPacks: product.lowStockThreshold });
    const avgDailySold = Math.round((sold.get(product.id) ?? 0) / 30 * 100) / 100;
    const daysOfCover = avgDailySold > 0 ? Math.floor(status.sellable / avgDailySold) : null;
    const lastSoldAt = last.get(product.id) ?? null;
    const valueAtCost = roundMoney(product.batches.reduce((sum, batch) => sum + batch.quantity / perPack * Number(batch.costPrice ?? 0), 0));
    const common = { productId: product.id, name: product.masterProduct?.name ?? product.name, company: product.masterProduct?.company ?? product.company, sellable: status.sellable, unitsPerPack: perPack, valueAtCost, lastSoldAt: lastSoldAt?.toISOString() ?? null, avgDailySold, daysOfCover };
    const unsoldSince = lastSoldAt ?? product.createdAt;
    if (status.sellable > 0 && now.getTime() - unsoldSince.getTime() > deadDays * DAY_MS) {
      items.push({ ...common, suggestedPacks: 0, reason: "dead" });
    } else if (status.lowStock || (daysOfCover !== null && daysOfCover < coverDays)) {
      // Enough for 30 days at the recent rate, or up to the alert level, whichever is more.
      const target = Math.max(sold.get(product.id) ?? 0, product.lowStockThreshold * perPack);
      items.push({ ...common, suggestedPacks: Math.max(1, Math.ceil((target - status.sellable) / perPack)), reason: "reorder" });
    }
  }
  return items.sort((a, b) => a.reason.localeCompare(b.reason) || b.valueAtCost - a.valueAtCost);
}

// ---------- master price updates ----------

/** Official price changes in the last `days` (and scheduled ones) for medicines this branch stocks. */
export async function priceUpdates(branchId: string, options: { now?: Date; days?: number } = {}): Promise<PriceUpdate[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? 30) * DAY_MS);
  const products = await db.product.findMany({
    where: { branchId, isActive: true, masterProduct: { priceHistory: { some: { OR: [{ effectiveFrom: { gte: since } }, { createdAt: { gte: since } }] } } } },
    include: { masterProduct: { include: { priceHistory: true } }, batches: { where: { quantity: { gt: 0 } } } }
  });
  const updates: PriceUpdate[] = [];
  for (const product of products) {
    const history = product.masterProduct!.priceHistory.map((entry) => ({ ...entry, price: Number(entry.price) }));
    const current = resolveCurrentPrice(history, now);
    const scheduled = history.filter((entry) => entry.effectiveFrom > now).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0];
    const latest = scheduled ?? current;
    if (!latest) continue;
    const previous = resolveCurrentPrice(history.filter((entry) => entry.id !== latest.id && entry.effectiveFrom <= latest.effectiveFrom), latest.effectiveFrom);
    const perPack = unitSize("pack", packStructure(product));
    updates.push({
      productId: product.id, name: product.masterProduct!.name, masterProductId: product.masterProductId!,
      oldPrice: previous?.price ?? null, newPrice: latest.price, effectiveFrom: latest.effectiveFrom.toISOString(), source: latest.source, reference: latest.reference, scheduled: latest.effectiveFrom > now,
      shopPrice: product.retailPriceOverride == null ? null : Number(product.retailPriceOverride),
      packsAtOtherPrices: Math.floor(product.batches.filter((batch) => Math.abs(Number(batch.retailPrice) - latest.price) > 0.005).reduce((sum, batch) => sum + batch.quantity, 0) / perPack)
    });
  }
  return updates.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

// ---------- shifts ----------

export async function shiftHistory(branches: ScopeBranch[], period: Period): Promise<ShiftSummary[]> {
  const shifts = await db.shift.findMany({
    where: { branchId: { in: branches.map((branch) => branch.id) }, openedAt: { gte: period.from, lt: period.to } },
    include: { user: { select: { name: true } }, sales: { where: { status: { not: "VOIDED" } }, select: { total: true } } },
    orderBy: { openedAt: "desc" }
  });
  const devices = new Map((await db.device.findMany({ where: { id: { in: shifts.map((shift) => shift.deviceId).filter((id): id is string => !!id) } }, select: { id: true, name: true } })).map((device) => [device.id, device.name]));
  return shifts.map((shift) => {
    const report = (shift.closingReport ?? null) as { expectedCash?: number; variance?: number | null } | null;
    return {
      id: shift.id, branchId: shift.branchId, deviceName: shift.deviceId ? devices.get(shift.deviceId) ?? null : null, userName: shift.user.name,
      status: shift.status === "OPEN" ? "open" : "closed",
      openedAt: shift.openedAt.toISOString(), closedAt: shift.closedAt?.toISOString() ?? null,
      openingCash: Number(shift.openingCash), closingCash: shift.closingCash == null ? null : Number(shift.closingCash),
      expectedCash: report?.expectedCash ?? null, variance: report?.variance ?? null,
      bills: shift.sales.length, revenue: roundMoney(shift.sales.reduce((sum, sale) => sum + Number(sale.total), 0))
    };
  });
}
