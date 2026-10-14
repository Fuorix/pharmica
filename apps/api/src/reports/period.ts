import type { AuthUser } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { apiError } from "../lib/api-response";

/** Pakistan Standard Time is UTC+5 all year (no daylight saving), so a business day runs 19:00 UTC to 19:00 UTC. */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 400;

/** The Pakistan calendar date (YYYY-MM-DD) of an instant. */
export function pkDay(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant a Pakistan calendar day starts. */
export function pkDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - PKT_OFFSET_MS);
}

export interface Period {
  /** First day included (YYYY-MM-DD, Pakistan time). */
  fromDay: string;
  /** Last day included. */
  toDay: string;
  from: Date;
  /** Exclusive end. */
  to: Date;
}

export function periodOf(fromDay: string, toDay: string): Period {
  return { fromDay, toDay, from: pkDayStart(fromDay), to: new Date(pkDayStart(toDay).getTime() + DAY_MS) };
}

/** Every Pakistan calendar day in a period, in order. */
export function daysOf(period: Period): string[] {
  const days: string[] = [];
  for (let at = period.from.getTime(); at < period.to.getTime(); at += DAY_MS) days.push(pkDay(new Date(at)));
  return days;
}

/** Reads `from` and `to` (YYYY-MM-DD, Pakistan time, both included); defaults to today. */
export function parsePeriod(params: URLSearchParams, now = new Date()): Period | { response: Response } {
  const today = pkDay(now);
  const fromDay = params.get("from") ?? today;
  const toDay = params.get("to") ?? fromDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || Number.isNaN(Date.parse(fromDay)) || Number.isNaN(Date.parse(toDay))) {
    return { response: apiError(400, "INVALID_PERIOD", "Dates must look like 2026-10-12") };
  }
  if (toDay < fromDay) return { response: apiError(400, "INVALID_PERIOD", "The end date is before the start date") };
  const period = periodOf(fromDay, toDay);
  if ((period.to.getTime() - period.from.getTime()) / DAY_MS > MAX_DAYS) return { response: apiError(400, "PERIOD_TOO_LONG", `Choose at most ${MAX_DAYS} days`) };
  return period;
}

export type ScopeBranch = { id: string; name: string; organisationId: string };

/**
 * The branches a report covers: `branchId=all` (or none) means every branch of the owner's organisation; otherwise
 * one branch the user may see. Pharmica admins must name the organisation or branch.
 */
export async function requireBranches(user: AuthUser, params: URLSearchParams): Promise<{ branches: ScopeBranch[] } | { response: Response }> {
  const requested = params.get("branchId");
  if (requested && requested !== "all") {
    const branch = await db.branch.findUnique({ where: { id: requested }, select: { id: true, name: true, organisationId: true } });
    const allowed = branch && (user.role === "super-admin" || (branch.organisationId === user.organisationId && (!user.branchId || user.branchId === branch.id)));
    if (!branch || !allowed) return { response: apiError(403, "FORBIDDEN", "Branch access denied") };
    return { branches: [branch] };
  }
  const organisationId = user.role === "super-admin" ? params.get("organisationId") : user.organisationId;
  if (!organisationId) return { response: apiError(400, "ORGANISATION_REQUIRED", "Choose an organisation or branch") };
  const branches = await db.branch.findMany({ where: { organisationId, ...(user.role !== "super-admin" && user.branchId ? { id: user.branchId } : {}) }, select: { id: true, name: true, organisationId: true }, orderBy: { name: "asc" } });
  return { branches };
}
