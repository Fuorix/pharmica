import { roundMoney } from "./units";

export type SubscriptionState = "TRIAL" | "ACTIVE" | "GRACE" | "EXPIRED" | "CANCELLED";
export type BillingPeriodName = "MONTHLY" | "QUARTERLY" | "YEARLY";

/** Days after the paid-through date during which the shop is in grace mode before it expires. */
export const GRACE_DAYS = 30;
/** Renewal reminders (and the renewal invoice) start this many days before the paid-through date. */
export const RENEWAL_NOTICE_DAYS = 7;
export const PERIOD_MONTHS: Record<BillingPeriodName, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

const DAY_MS = 86_400_000;

export interface SubscriptionDates {
  /** True until the first paid invoice. */
  isTrial: boolean;
  /** Trial end, or the end of the last paid period. */
  paidThrough: Date;
  cancelledAt: Date | null;
}

/**
 * The subscription state at an instant, from the dates alone, so the same inputs always give the same answer:
 * trial or active until the paid-through date, then grace for GRACE_DAYS, then expired. Cancelled wins.
 */
export function subscriptionState(subscription: SubscriptionDates, now: Date): SubscriptionState {
  if (subscription.cancelledAt && subscription.cancelledAt.getTime() <= now.getTime()) return "CANCELLED";
  const end = subscription.paidThrough.getTime();
  if (now.getTime() < end) return subscription.isTrial ? "TRIAL" : "ACTIVE";
  if (now.getTime() < end + GRACE_DAYS * DAY_MS) return "GRACE";
  return "EXPIRED";
}

/** When grace mode ends (and the subscription expires) if nothing is paid. */
export function graceEndsAt(paidThrough: Date): Date {
  return new Date(paidThrough.getTime() + GRACE_DAYS * DAY_MS);
}

export interface SubscriptionAccess {
  /** Billing at the counter never stops, whatever the subscription. */
  billing: true;
  /** Owners can always take their data away. */
  export: true;
  /** Owners can always see and pay their invoices. */
  payments: true;
  /** Counters upload sales and download updates. */
  sync: boolean;
  /** Dashboard, reports, and accounting in the owner panel. */
  reports: boolean;
  /** The owner mobile app. */
  mobile: boolean;
  /** Adding counters, staff, and branches. */
  manage: boolean;
}

/**
 * Grace-mode policy. In grace, counters keep billing offline and owners keep export and payment, but cloud sync,
 * reports, and mobile access pause until the shop pays. Once expired, new counters, staff, and branches are blocked too.
 * Nothing here ever stops local billing, and work queued at the counter waits safely for the shop to renew.
 */
export function accessFor(state: SubscriptionState): SubscriptionAccess {
  const full = state === "TRIAL" || state === "ACTIVE";
  return { billing: true, export: true, payments: true, sync: full, reports: full, mobile: full, manage: full || state === "GRACE" };
}

/** Whole days until the instant (negative once it has passed). */
export function daysUntil(at: Date, now: Date): number {
  return Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
}

/** True when the shop should be reminded to renew: still working, and the paid-through date is close. */
export function renewalDue(subscription: SubscriptionDates, now: Date): boolean {
  const state = subscriptionState(subscription, now);
  return (state === "TRIAL" || state === "ACTIVE") && subscription.paidThrough.getTime() - now.getTime() <= RENEWAL_NOTICE_DAYS * DAY_MS;
}

/** Adds calendar months, keeping the time of day; the 31st becomes the last day of a shorter month. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export interface PlanPricing {
  monthlyPrice: number;
  quarterlyDiscountPercent: number;
  yearlyDiscountPercent: number;
}

/** The price of one billing period, with the prepay discount for longer periods. */
export function periodPrice(plan: PlanPricing, period: BillingPeriodName): { months: number; subtotal: number; discount: number; total: number } {
  const months = PERIOD_MONTHS[period];
  const subtotal = roundMoney(plan.monthlyPrice * months);
  const percent = period === "QUARTERLY" ? plan.quarterlyDiscountPercent : period === "YEARLY" ? plan.yearlyDiscountPercent : 0;
  const discount = roundMoney(subtotal * percent / 100);
  return { months, subtotal, discount, total: roundMoney(subtotal - discount) };
}

/**
 * Where the next paid period starts. A shop that renews on time, in its trial, or in grace continues from its
 * paid-through date, so periods never overlap or leave gaps; one that has expired or was cancelled starts again from now.
 */
export function nextPeriodStart(subscription: SubscriptionDates, now: Date): Date {
  const state = subscriptionState(subscription, now);
  return state === "EXPIRED" || state === "CANCELLED" ? now : subscription.paidThrough;
}
