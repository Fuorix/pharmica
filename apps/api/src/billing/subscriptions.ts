import type { InvoiceSummary, PaymentSummary, PlanSummary, SubscriptionEventItem, SubscriptionSummary } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { accessFor, addMonths, daysUntil, graceEndsAt, nextPeriodStart, periodPrice, renewalDue, roundMoney, subscriptionState, type BillingPeriodName, type SubscriptionAccess, type SubscriptionState } from "@pharmica/domain";
import { apiError } from "../lib/api-response";

export type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;
type PlanRow = Prisma.PlanGetPayload<object>;
type InvoiceRow = Prisma.SubscriptionInvoiceGetPayload<{ include: { plan: true; payments: true; organisation: { select: { name: true } } } }>;
type PaymentRow = Prisma.SubscriptionPaymentGetPayload<{ include: { invoice: { select: { number: true } }; organisation: { select: { name: true } } } }>;

export const DEFAULT_PAY_INSTRUCTIONS = "Pay your Pharmica representative in cash, or transfer to the Pharmica bank account quoting the invoice number. The payment and its receipt number appear here as soon as it is recorded.";

export function toPlanSummary(plan: PlanRow): PlanSummary {
  return {
    id: plan.id, code: plan.code, name: plan.name, monthlyPrice: Number(plan.monthlyPrice),
    quarterlyDiscountPercent: plan.quarterlyDiscountPercent, yearlyDiscountPercent: plan.yearlyDiscountPercent,
    maxBranches: plan.maxBranches, maxDevices: plan.maxDevices, features: plan.features, trialDays: plan.trialDays, isActive: plan.isActive
  };
}

const datesOf = (subscription: { isTrial: boolean; paidThrough: Date; cancelledAt: Date | null }) => ({ isTrial: subscription.isTrial, paidThrough: subscription.paidThrough, cancelledAt: subscription.cancelledAt });

export function summarize(subscription: SubscriptionRow, now = new Date()): SubscriptionSummary {
  const status = subscriptionState(datesOf(subscription), now);
  return {
    status, isTrial: subscription.isTrial, plan: toPlanSummary(subscription.plan), period: subscription.period,
    paidThrough: subscription.paidThrough.toISOString(), graceEndsAt: graceEndsAt(subscription.paidThrough).toISOString(),
    daysLeft: daysUntil(subscription.paidThrough, now), renewalDue: renewalDue(datesOf(subscription), now),
    access: accessFor(status), features: subscription.plan.features
  };
}

export function toInvoiceSummary(invoice: InvoiceRow): InvoiceSummary {
  const paid = invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((sum, payment) => sum + Number(payment.amount), 0);
  return {
    id: invoice.id, number: invoice.number, organisationId: invoice.organisationId, organisationName: invoice.organisation.name, planName: invoice.plan.name,
    period: invoice.period, periodStart: invoice.periodStart.toISOString(), periodEnd: invoice.periodEnd.toISOString(),
    subtotal: Number(invoice.subtotal), discount: Number(invoice.discount), total: Number(invoice.total),
    balance: invoice.status === "OPEN" ? roundMoney(Math.max(0, Number(invoice.total) - paid)) : 0,
    status: invoice.status, issuedAt: invoice.issuedAt.toISOString(), dueAt: invoice.dueAt.toISOString(), paidAt: invoice.paidAt?.toISOString() ?? null
  };
}

export const invoiceInclude = { plan: true, payments: true, organisation: { select: { name: true } } } as const;
export const paymentInclude = { invoice: { select: { number: true } }, organisation: { select: { name: true } } } as const;

export async function toPaymentSummaries(payments: PaymentRow[]): Promise<PaymentSummary[]> {
  const recorders = new Map((await db.user.findMany({ where: { id: { in: payments.map((payment) => payment.recordedById).filter((id): id is string => !!id) } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
  return payments.map((payment) => ({
    id: payment.id, organisationId: payment.organisationId, organisationName: payment.organisation?.name ?? null, invoiceId: payment.invoiceId, invoiceNumber: payment.invoice?.number ?? null,
    method: payment.method, status: payment.status, amount: Number(payment.amount), reference: payment.reference, providerTransactionId: payment.providerTransactionId,
    note: payment.note, receivedAt: payment.receivedAt.toISOString(), recordedBy: payment.recordedById ? recorders.get(payment.recordedById) ?? null : null
  }));
}

export async function eventItems(subscriptionId: string): Promise<SubscriptionEventItem[]> {
  const events = await db.subscriptionEvent.findMany({ where: { subscriptionId }, orderBy: { createdAt: "desc" }, take: 100 });
  const actors = new Map((await db.user.findMany({ where: { id: { in: events.map((event) => event.actorId).filter((id): id is string => !!id) } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
  return events.map((event) => ({ id: event.id, type: event.type, fromStatus: event.fromStatus, toStatus: event.toStatus, reason: event.reason, actor: event.actorId ? actors.get(event.actorId) ?? null : null, createdAt: event.createdAt.toISOString() }));
}

/** Locks an organisation's subscription row for the rest of the transaction, so concurrent changes queue up. */
async function lockSubscription(tx: Prisma.TransactionClient, organisationId: string): Promise<SubscriptionRow | null> {
  await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "organisationId" = ${organisationId} FOR UPDATE`;
  return tx.subscription.findUnique({ where: { organisationId }, include: { plan: true } });
}

/** Stores the computed status if it changed, with an event saying why. Call inside a transaction holding the lock. */
async function settleStatus(tx: Prisma.TransactionClient, subscription: SubscriptionRow, now: Date, reason: string, actorId?: string): Promise<SubscriptionRow> {
  const status = subscriptionState(datesOf(subscription), now);
  if (status === subscription.status) return subscription;
  await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "status_changed", fromStatus: subscription.status, toStatus: status, actorId, reason } });
  return tx.subscription.update({ where: { id: subscription.id }, data: { status, statusChangedAt: now }, include: { plan: true } });
}

function transitionReason(from: SubscriptionState, to: SubscriptionState, paidThrough: Date): string {
  if (to === "GRACE") return `Not renewed by ${paidThrough.toISOString().slice(0, 10)}: grace mode`;
  if (to === "EXPIRED") return "Grace period ended without payment";
  if (to === "ACTIVE" && from !== "TRIAL") return "Renewed";
  return `Status is now ${to.toLowerCase()}`;
}

/** The next invoice number for the year, e.g. PH-2026-000042. Serialised with an advisory lock. */
async function nextInvoiceNumber(tx: Prisma.TransactionClient, now: Date): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pharmica_invoice_number'))`;
  const prefix = `PH-${now.getUTCFullYear()}-`;
  const last = await tx.subscriptionInvoice.findFirst({ where: { number: { startsWith: prefix } }, orderBy: { number: "desc" }, select: { number: true } });
  const next = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

/**
 * The shop's open renewal invoice, issued if there is none. Asking for a different billing period (or plan) replaces
 * an unpaid open invoice, which is voided with a note, never deleted.
 */
export async function ensureOpenInvoice(tx: Prisma.TransactionClient, subscription: SubscriptionRow, now: Date, options: { period?: BillingPeriodName; plan?: PlanRow; actorId?: string } = {}) {
  const period = options.period ?? subscription.period;
  const plan = options.plan ?? subscription.plan;
  const open = await tx.subscriptionInvoice.findFirst({ where: { subscriptionId: subscription.id, status: "OPEN" }, include: { payments: true }, orderBy: { issuedAt: "desc" } });
  if (open && open.period === period && open.planId === plan.id) return open;
  if (open) {
    if (open.payments.some((payment) => payment.status === "SUCCEEDED")) return open;
    await tx.subscriptionInvoice.update({ where: { id: open.id }, data: { status: "VOID", voidedAt: now, voidReason: `Replaced by a ${period.toLowerCase()} ${plan.name} invoice` } });
  }
  const price = periodPrice({ monthlyPrice: Number(plan.monthlyPrice), quarterlyDiscountPercent: plan.quarterlyDiscountPercent, yearlyDiscountPercent: plan.yearlyDiscountPercent }, period);
  const periodStart = nextPeriodStart(datesOf(subscription), now);
  const invoice = await tx.subscriptionInvoice.create({
    data: {
      number: await nextInvoiceNumber(tx, now), organisationId: subscription.organisationId, subscriptionId: subscription.id, planId: plan.id, period, months: price.months,
      periodStart, periodEnd: addMonths(periodStart, price.months), subtotal: price.subtotal, discount: price.discount, total: price.total,
      issuedAt: now, dueAt: subscription.paidThrough > now ? subscription.paidThrough : now
    },
    include: { payments: true }
  });
  await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "invoice_issued", actorId: options.actorId, reason: `Invoice ${invoice.number}: ${plan.name}, ${period.toLowerCase()}, PKR ${price.total}`, metadata: { invoiceId: invoice.id } } });
  return invoice;
}

/**
 * Brings a subscription up to date: stores a changed status (with its event) and issues the renewal invoice once
 * renewal is due or the shop has lapsed. Safe to call on every request; it does nothing when nothing changed.
 */
export async function refreshSubscription(organisationId: string, now = new Date()): Promise<SubscriptionRow | null> {
  const current = await db.subscription.findUnique({ where: { organisationId }, include: { plan: true } });
  if (!current) return null;
  const status = subscriptionState(datesOf(current), now);
  const needsInvoice = status !== "CANCELLED" && (renewalDue(datesOf(current), now) || status === "GRACE" || status === "EXPIRED");
  if (status === current.status && !needsInvoice) return current;
  if (status === current.status && needsInvoice && await db.subscriptionInvoice.count({ where: { subscriptionId: current.id, status: "OPEN" } })) return current;
  return db.$transaction(async (tx) => {
    let subscription = await lockSubscription(tx, organisationId);
    if (!subscription) return null;
    subscription = await settleStatus(tx, subscription, now, transitionReason(subscription.status, status, subscription.paidThrough));
    if (needsInvoice) await ensureOpenInvoice(tx, subscription, now);
    return subscription;
  });
}

/**
 * Records a payment and applies it. Once an invoice is fully paid the subscription runs to the end of the period it
 * pays for: from the old paid-through date if the shop renewed on time, in trial, or in grace; from today if it had
 * expired. A payment that does not match an invoice is kept as UNMATCHED for a person to sort out.
 */
export async function recordPayment(input: {
  organisationId: string | null; invoiceId: string | null; method: Prisma.SubscriptionPaymentCreateInput["method"]; amount: number; reference?: string | null;
  providerTransactionId?: string | null; note?: string | null; raw?: Prisma.InputJsonValue; recordedById?: string | null; receivedAt?: Date; status?: "SUCCEEDED" | "FAILED" | "UNMATCHED";
}, now = new Date()) {
  return db.$transaction(async (tx) => {
    const invoice = input.invoiceId ? await tx.subscriptionInvoice.findUnique({ where: { id: input.invoiceId } }) : null;
    const subscription = invoice ? await lockSubscription(tx, invoice.organisationId) : null;
    const payment = await tx.subscriptionPayment.create({
      data: {
        organisationId: input.organisationId ?? invoice?.organisationId ?? null, invoiceId: invoice?.id ?? null, method: input.method, status: input.status ?? "SUCCEEDED",
        amount: input.amount, reference: input.reference ?? null, providerTransactionId: input.providerTransactionId ?? null, note: input.note ?? null,
        raw: input.raw, recordedById: input.recordedById ?? null, receivedAt: input.receivedAt ?? now
      }
    });
    if (!invoice || !subscription || payment.status !== "SUCCEEDED" || invoice.status !== "OPEN") return { payment, invoice, subscription, applied: false };
    return applyToInvoice(tx, payment, invoice, subscription, input.recordedById ?? undefined, now);
  });
}

type PaymentRecord = Prisma.SubscriptionPaymentGetPayload<object>;
type InvoiceRecord = Prisma.SubscriptionInvoiceGetPayload<object>;

/** Counts a successful payment against its invoice; when the invoice is fully paid, extends the subscription. */
async function applyToInvoice(tx: Prisma.TransactionClient, payment: PaymentRecord, invoice: InvoiceRecord, subscription: SubscriptionRow, actorId: string | undefined, now: Date) {
  const paid = (await tx.subscriptionPayment.aggregate({ where: { invoiceId: invoice.id, status: "SUCCEEDED" }, _sum: { amount: true } }))._sum.amount;
  await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "payment_received", actorId, reason: `PKR ${Number(payment.amount)} by ${payment.method.toLowerCase().replace("_", " ")} for ${invoice.number}${payment.reference ? ` (ref ${payment.reference})` : ""}`, metadata: { paymentId: payment.id } } });
  if (Number(paid ?? 0) + 0.005 < Number(invoice.total)) return { payment, invoice, subscription, applied: false };

  const start = nextPeriodStart(datesOf(subscription), now);
  const end = addMonths(start, invoice.months);
  const paidInvoice = await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt: now, periodStart: start, periodEnd: end } });
  const before = subscription.status;
  subscription = await tx.subscription.update({ where: { id: subscription.id }, data: { paidThrough: end, isTrial: false, period: invoice.period, planId: invoice.planId, cancelledAt: null }, include: { plan: true } });
  await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "period_paid", actorId, reason: `${invoice.number} paid: now paid through ${end.toISOString().slice(0, 10)}`, metadata: { invoiceId: invoice.id, periodStart: start.toISOString(), periodEnd: end.toISOString() } } });
  subscription = await settleStatus(tx, subscription, now, transitionReason(before, subscriptionState(datesOf(subscription), now), end), actorId);
  return { payment, invoice: paidInvoice, subscription, applied: true };
}

/** Matches a payment kept as UNMATCHED (or one recorded without an invoice) to an open invoice, and applies it. */
export async function matchPayment(paymentId: string, invoiceId: string, actorId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    const invoice = await tx.subscriptionInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.status !== "OPEN") return { error: "The invoice is not open" } as const;
    const subscription = await lockSubscription(tx, invoice.organisationId);
    const existing = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
    if (!existing || existing.status === "FAILED" || (existing.invoiceId && existing.status === "SUCCEEDED")) return { error: "This payment cannot be matched" } as const;
    const payment = await tx.subscriptionPayment.update({ where: { id: paymentId }, data: { invoiceId: invoice.id, organisationId: invoice.organisationId, status: "SUCCEEDED", note: [existing.note, `Matched to ${invoice.number}`].filter(Boolean).join(" · ") } });
    return applyToInvoice(tx, payment, invoice, subscription!, actorId, now);
  });
}

/** Admin changes outside payments: plan or period for the next renewal, an extension, cancellation, reactivation. */
export async function changeSubscription(organisationId: string, change: { planId?: string; period?: BillingPeriodName; extendDays?: number; cancel?: boolean; reactivate?: boolean; reason: string; actorId: string }, now = new Date()) {
  return db.$transaction(async (tx) => {
    let subscription = await lockSubscription(tx, organisationId);
    if (!subscription) return null;
    const data: Prisma.SubscriptionUpdateInput = {};
    const notes: string[] = [];
    if (change.planId && change.planId !== subscription.planId) { data.plan = { connect: { id: change.planId } }; notes.push("plan changed"); }
    if (change.period && change.period !== subscription.period) { data.period = change.period; notes.push(`billing ${change.period.toLowerCase()}`); }
    if (change.extendDays) {
      // An extension (e.g. a promise to pay) never shortens what was paid, and counts from today if already lapsed.
      const from = subscription.paidThrough > now ? subscription.paidThrough : now;
      data.paidThrough = new Date(from.getTime() + change.extendDays * 86_400_000);
      notes.push(`extended ${change.extendDays} days`);
    }
    if (change.cancel) { data.cancelledAt = now; notes.push("cancelled"); }
    if (change.reactivate) { data.cancelledAt = null; notes.push("reactivated"); }
    subscription = await tx.subscription.update({ where: { id: subscription.id }, data, include: { plan: true } });
    await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "changed", actorId: change.actorId, reason: `${notes.join(", ")}: ${change.reason}`, metadata: { ...change } } });
    const before = subscription.status;
    subscription = await settleStatus(tx, subscription, now, transitionReason(before, subscriptionState(datesOf(subscription), now), subscription.paidThrough), change.actorId);
    // A changed plan or period re-prices the open renewal invoice if nothing has been paid on it.
    if ((change.planId || change.period) && await tx.subscriptionInvoice.count({ where: { subscriptionId: subscription.id, status: "OPEN" } })) await ensureOpenInvoice(tx, subscription, now, { actorId: change.actorId });
    return subscription;
  });
}

// ---------- access checks ----------

const lapsedMessage: Record<SubscriptionState, string> = {
  TRIAL: "", ACTIVE: "",
  GRACE: "The subscription has lapsed, so this is paused (grace mode). Billing and data export still work; renew to turn it back on.",
  EXPIRED: "The subscription has expired, so this is paused. Billing and data export still work; renew to turn it back on.",
  CANCELLED: "The subscription was cancelled, so this is paused. Billing and data export still work; contact Pharmica to restart."
};

export type Capability = keyof Omit<SubscriptionAccess, "billing" | "export" | "payments">;

/** The subscription of an organisation, brought up to date, with what it currently allows. */
export async function subscriptionAccess(organisationId: string, now = new Date()): Promise<{ subscription: SubscriptionRow | null; state: SubscriptionState; access: SubscriptionAccess }> {
  const subscription = await refreshSubscription(organisationId, now);
  // A pharmacy without a subscription record is treated as expired, never as free.
  const state = subscription ? subscriptionState(datesOf(subscription), now) : "EXPIRED";
  return { subscription, state, access: accessFor(state) };
}

/** null when allowed; otherwise a 402 saying what is paused and why. */
export async function requireCapability(organisationId: string, capability: Capability, now = new Date()): Promise<Response | null> {
  const { state, access } = await subscriptionAccess(organisationId, now);
  if (access[capability]) return null;
  return apiError(402, "SUBSCRIPTION_LAPSED", lapsedMessage[state] || "Not available on this subscription", { status: state, capability });
}

/** null when the plan includes the feature (and the subscription is working); otherwise a 402. */
export async function requireFeature(organisationId: string, feature: string, now = new Date()): Promise<Response | null> {
  const { subscription, state, access } = await subscriptionAccess(organisationId, now);
  if (!access.reports) return apiError(402, "SUBSCRIPTION_LAPSED", lapsedMessage[state], { status: state, capability: "reports" });
  if (!subscription?.plan.features.includes(feature)) return apiError(402, "FEATURE_NOT_IN_PLAN", `${subscription?.plan.name ?? "This"} plan does not include this. Upgrade to use it.`, { feature, plan: subscription?.plan.code ?? null });
  return null;
}

/** null when one more branch or active counter fits the plan. */
export async function requireRoomFor(organisationId: string, kind: "branches" | "devices", now = new Date()): Promise<Response | null> {
  const lapsed = await requireCapability(organisationId, "manage", now);
  if (lapsed) return lapsed;
  const subscription = await db.subscription.findUnique({ where: { organisationId }, include: { plan: true } });
  const limit = kind === "branches" ? subscription?.plan.maxBranches : subscription?.plan.maxDevices;
  if (limit == null) return null;
  const used = kind === "branches"
    ? await db.branch.count({ where: { organisationId } })
    : await db.device.count({ where: { branch: { organisationId }, isActive: true } });
  if (used < limit) return null;
  return apiError(402, "PLAN_LIMIT_REACHED", `The ${subscription!.plan.name} plan allows ${limit} ${kind === "branches" ? "branch" : "active counter"}${limit === 1 ? "" : kind === "branches" ? "es" : "s"}. Upgrade or deactivate one first.`, { kind, limit });
}

/** Cloud sync for a counter: refused while the pharmacy is suspended or its subscription has lapsed. */
export async function requireCloudSync(organisation: { id: string; isActive: boolean }, now = new Date()): Promise<Response | null> {
  if (!organisation.isActive) return apiError(403, "ORGANISATION_SUSPENDED", "This pharmacy is suspended. Billing continues on the counter; contact Pharmica support.");
  return requireCapability(organisation.id, "sync", now);
}
