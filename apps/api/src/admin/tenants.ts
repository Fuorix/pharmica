import { randomBytes } from "node:crypto";
import type { AdminOverview, CollectionsDashboard, CreateTenantRequest, DeviceDiagnostics, MigrationStatus, OnboardingStep, SubscriptionStatus, SupportView, TenantDetail, TenantListItem } from "@pharmica/contracts";
import { db, type Prisma } from "@pharmica/database/client";
import { daysUntil, periodPrice, renewalDue, roundMoney, subscriptionState } from "@pharmica/domain";
import { newActivationCode } from "../auth/authorization";
import { hashCredential } from "../auth/credentials";
import { toRoleName } from "../auth/session";
import { ensureOpenInvoice, eventItems, invoiceInclude, paymentInclude, refreshSubscription, summarize, toInvoiceSummary, toPaymentSummaries } from "../billing/subscriptions";

const DAY_MS = 86_400_000;
const STATUSES: SubscriptionStatus[] = ["TRIAL", "ACTIVE", "GRACE", "EXPIRED", "CANCELLED"];
const emptyCounts = (): Record<SubscriptionStatus, number> => ({ TRIAL: 0, ACTIVE: 0, GRACE: 0, EXPIRED: 0, CANCELLED: 0 });

/** A temporary password that is easy to read out over the phone: no look-alike characters. */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

type Onboarding = { migrationStatus?: MigrationStatus; migrationNote?: string | null };
const onboardingOf = (value: Prisma.JsonValue | null): Onboarding => value && typeof value === "object" && !Array.isArray(value) ? value as Onboarding : {};

/** Creates a pharmacy ready to go live: organisation, first branch, owner with a temporary password, subscription, and counters. */
export async function createTenant(input: CreateTenantRequest, actorId: string, now = new Date()) {
  const plan = await db.plan.findFirst({ where: { code: input.planCode, isActive: true } });
  if (!plan) return { error: "Choose an active plan" } as const;
  const login = input.ownerLogin.trim().toLowerCase();
  if (await db.user.findUnique({ where: { login } })) return { error: "That owner login is already used" } as const;
  const counters = input.counters ?? 1;
  if (plan.maxDevices != null && counters > plan.maxDevices) return { error: `The ${plan.name} plan allows ${plan.maxDevices} counters` } as const;
  const trialDays = input.trialDays ?? plan.trialDays;
  const password = temporaryPassword();
  const credentialHash = await hashCredential(password);

  const organisationId = await db.$transaction(async (tx) => {
    const organisation = await tx.organisation.create({ data: { name: input.pharmacyName.trim(), contactName: input.contactName.trim(), phone: input.phone?.trim() || null, city: input.city?.trim() || null, onboarding: { migrationStatus: "NOT_STARTED" } } });
    const branch = await tx.branch.create({ data: { organisationId: organisation.id, name: input.branchName.trim(), address: input.branchAddress?.trim() || null, phone: input.phone?.trim() || null } });
    const owner = await tx.user.create({ data: { organisationId: organisation.id, name: input.ownerName.trim(), login, credentialHash, mustChangeCredential: true, role: "OWNER" } });
    for (let index = 1; index <= counters; index++) {
      await tx.device.create({ data: { branchId: branch.id, name: counters === 1 ? "Counter" : `Counter ${index}`, activationCode: newActivationCode() } });
    }
    // A trial runs for its days; with no trial the shop starts unpaid and the first invoice is due now.
    const subscription = await tx.subscription.create({
      data: { organisationId: organisation.id, planId: plan.id, period: input.period ?? "MONTHLY", status: trialDays > 0 ? "TRIAL" : "GRACE", isTrial: trialDays > 0, paidThrough: new Date(now.getTime() + trialDays * DAY_MS) },
      include: { plan: true }
    });
    await tx.subscriptionEvent.create({ data: { subscriptionId: subscription.id, type: "created", toStatus: subscription.status, actorId, reason: trialDays > 0 ? `${plan.name} plan, ${trialDays}-day trial` : `${plan.name} plan, paid from the start` } });
    if (trialDays === 0) await ensureOpenInvoice(tx, subscription, now, { actorId });
    await tx.auditLog.create({ data: { organisationId: organisation.id, branchId: branch.id, userId: actorId, action: "tenant.created", entityType: "organisation", entityId: organisation.id, metadata: { plan: plan.code, trialDays, counters, ownerId: owner.id } } });
    return organisation.id;
  });
  return { organisationId, temporaryPassword: password };
}

/** The checklist that tells support how far a new pharmacy is from going live. */
async function checklist(organisationId: string, now: Date): Promise<OnboardingStep[]> {
  const [organisation, owners, firstBranch, activated, staffWithPins, stocked, sales, subscription] = await Promise.all([
    db.organisation.findUniqueOrThrow({ where: { id: organisationId } }),
    db.user.findMany({ where: { organisationId, role: "OWNER" }, select: { id: true, mustChangeCredential: true } }),
    db.branch.findFirst({ where: { organisationId }, orderBy: { name: "asc" } }),
    db.device.count({ where: { branch: { organisationId }, activatedAt: { not: null } } }),
    db.user.count({ where: { organisationId, isActive: true, pinHash: { not: null } } }),
    db.batch.count({ where: { quantity: { gt: 0 }, product: { branch: { organisationId } } } }),
    db.sale.count({ where: { branch: { organisationId } } }),
    db.subscription.findUnique({ where: { organisationId }, include: { plan: true } })
  ]);
  const imports = await db.importJob.count({ where: { organisationId, status: "COMMITTED" } });
  const signedIn = owners.length ? await db.auditLog.count({ where: { userId: { in: owners.map((owner) => owner.id) }, action: "auth.login" } }) : 0;
  const migration = onboardingOf(organisation.onboarding).migrationStatus ?? "NOT_STARTED";
  const state = subscription ? subscriptionState({ isTrial: subscription.isTrial, paidThrough: subscription.paidThrough, cancelledAt: subscription.cancelledAt }, now) : null;
  return [
    { key: "owner", label: "Owner signed in and set their own password", done: signedIn > 0 && owners.some((owner) => !owner.mustChangeCredential), detail: owners.some((owner) => owner.mustChangeCredential) ? "Still on the temporary password" : undefined },
    { key: "branch", label: "Branch address and phone for receipts", done: !!(firstBranch?.address && firstBranch.phone) },
    { key: "counter", label: "A counter is activated", done: activated > 0, detail: `${activated} activated` },
    { key: "staff", label: "Counter staff have PINs", done: staffWithPins > 0 },
    { key: "migration", label: "Old records moved over (or not needed)", done: migration === "DONE" || migration === "NOT_NEEDED", detail: `${migration.replace("_", " ").toLowerCase()}${imports ? ` · ${imports} import${imports === 1 ? "" : "s"} committed` : ""}` },
    { key: "stock", label: "Stock entered", done: stocked > 0, detail: `${stocked} batches in stock` },
    { key: "sale", label: "First sale reached the cloud", done: sales > 0 },
    { key: "paid", label: "First payment received", done: !!subscription && !subscription.isTrial, detail: state ? state.toLowerCase() : "no subscription" }
  ];
}

export async function tenantDetail(organisationId: string, now = new Date()): Promise<TenantDetail | null> {
  const organisation = await db.organisation.findUnique({ where: { id: organisationId } });
  if (!organisation) return null;
  await refreshSubscription(organisationId, now);
  const [branches, users, devices, subscription, invoices, payments, steps] = await Promise.all([
    db.branch.findMany({ where: { organisationId }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { organisationId }, orderBy: { createdAt: "asc" } }),
    db.device.findMany({ where: { branch: { organisationId } }, orderBy: { createdAt: "asc" } }),
    db.subscription.findUnique({ where: { organisationId }, include: { plan: true } }),
    db.subscriptionInvoice.findMany({ where: { organisationId }, include: invoiceInclude, orderBy: { issuedAt: "desc" }, take: 50 }),
    db.subscriptionPayment.findMany({ where: { organisationId }, include: paymentInclude, orderBy: { receivedAt: "desc" }, take: 50 }),
    checklist(organisationId, now)
  ]);
  const lastLogins = new Map((await db.auditLog.groupBy({ by: ["userId"], where: { userId: { in: users.map((user) => user.id) }, action: { in: ["auth.login", "auth.pin_login"] } }, _max: { createdAt: true } })).map((row) => [row.userId, row._max.createdAt]));
  const onboarding = onboardingOf(organisation.onboarding);
  return {
    id: organisation.id, name: organisation.name, contactName: organisation.contactName, phone: organisation.phone, city: organisation.city, isActive: organisation.isActive, createdAt: organisation.createdAt.toISOString(),
    migrationStatus: onboarding.migrationStatus ?? "NOT_STARTED", migrationNote: onboarding.migrationNote ?? null,
    branches: branches.map((branch) => ({ id: branch.id, name: branch.name, address: branch.address, phone: branch.phone })),
    users: users.map((user) => ({ id: user.id, name: user.name, login: user.login, role: toRoleName(user.role), branchId: user.branchId, isActive: user.isActive, hasPin: user.pinHash != null, mustChangeCredential: user.mustChangeCredential, lastLoginAt: lastLogins.get(user.id)?.toISOString() ?? null })),
    // The activation code is only useful (and only shown) until the counter is activated.
    devices: devices.map((device) => ({ id: device.id, name: device.name, branchId: device.branchId, activationCode: device.secretHash ? null : device.activationCode, activatedAt: device.activatedAt?.toISOString() ?? null, isActive: device.isActive, lastSeenAt: device.lastSeenAt?.toISOString() ?? null })),
    subscription: subscription ? summarize(subscription, now) : null,
    invoices: invoices.map(toInvoiceSummary),
    payments: await toPaymentSummaries(payments),
    events: subscription ? await eventItems(subscription.id) : [],
    checklist: steps
  };
}

export async function tenantList(query: string | null, now = new Date()): Promise<TenantListItem[]> {
  const organisations = await db.organisation.findMany({
    where: query ? { OR: [{ name: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }, { phone: { contains: query } }, { users: { some: { login: { contains: query.toLowerCase() } } } }] } : undefined,
    include: { subscription: { include: { plan: true } }, branches: { select: { id: true } } },
    orderBy: { createdAt: "desc" },
    take: 500
  });
  const ids = organisations.map((organisation) => organisation.id);
  const [devices, invoices, steps] = await Promise.all([
    db.device.findMany({ where: { branch: { organisationId: { in: ids } } }, select: { isActive: true, activatedAt: true, lastSeenAt: true, branch: { select: { organisationId: true } } } }),
    db.subscriptionInvoice.findMany({ where: { organisationId: { in: ids }, status: "OPEN" }, include: { payments: true } }),
    Promise.all(organisations.map((organisation) => checklist(organisation.id, now)))
  ]);
  return organisations.map((organisation, index) => {
    const mine = devices.filter((device) => device.branch.organisationId === organisation.id);
    const subscription = organisation.subscription;
    const balance = invoices.filter((invoice) => invoice.organisationId === organisation.id).reduce((sum, invoice) => sum + Number(invoice.total) - invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((paid, payment) => paid + Number(payment.amount), 0), 0);
    const lastSeen = mine.map((device) => device.lastSeenAt).filter((at): at is Date => !!at).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      id: organisation.id, name: organisation.name, city: organisation.city, phone: organisation.phone, isActive: organisation.isActive, createdAt: organisation.createdAt.toISOString(),
      branches: organisation.branches.length, devices: mine.length, activeDevices: mine.filter((device) => device.isActive && device.activatedAt).length,
      status: subscription ? subscriptionState({ isTrial: subscription.isTrial, paidThrough: subscription.paidThrough, cancelledAt: subscription.cancelledAt }, now) : null,
      planName: subscription?.plan.name ?? null, paidThrough: subscription?.paidThrough.toISOString() ?? null, openBalance: roundMoney(Math.max(0, balance)),
      lastSeenAt: lastSeen?.toISOString() ?? null, onboardingDone: steps[index].filter((step) => step.done).length, onboardingTotal: steps[index].length
    };
  });
}

/** What support needs to diagnose a shop without database access: counter health, stuck uploads, and the audit trail. */
export async function supportView(organisationId: string, cursor: string | null): Promise<SupportView> {
  const devices = await db.device.findMany({ where: { branch: { organisationId } }, include: { branch: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  const deviceIds = devices.map((device) => device.id);
  const [operationCounts, flagged, problems, products, batches, sales, customers] = await Promise.all([
    db.syncOperation.groupBy({ by: ["deviceId", "status"], where: { deviceId: { in: deviceIds } }, _count: { _all: true } }),
    db.syncOperation.groupBy({ by: ["deviceId"], where: { deviceId: { in: deviceIds }, reviewedAt: null, OR: [{ status: { in: ["FAILED", "CONFLICT"] } }, { flags: { isEmpty: false } }] }, _count: { _all: true } }),
    db.syncOperation.findMany({
      where: { deviceId: { in: deviceIds }, OR: [{ status: { in: ["FAILED", "CONFLICT", "PENDING"] } }, { flags: { isEmpty: false }, reviewedAt: null }] },
      select: { idempotencyKey: true, deviceId: true, entityType: true, status: true, flags: true, errorMessage: true, retryCount: true, occurredAt: true, processedAt: true },
      orderBy: { createdAt: "desc" }, take: 50
    }),
    db.product.count({ where: { branch: { organisationId } } }),
    db.batch.count({ where: { product: { branch: { organisationId } } } }),
    db.sale.count({ where: { branch: { organisationId } } }),
    db.customer.count({ where: { branch: { organisationId } } })
  ]);
  const names = new Map(devices.map((device) => [device.id, device.name]));
  const count = (deviceId: string, status: string) => operationCounts.find((row) => row.deviceId === deviceId && row.status === status)?._count._all ?? 0;

  const branchIds = (await db.branch.findMany({ where: { organisationId }, select: { id: true, name: true } }));
  const after = cursor ? await db.auditLog.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true } }) : null;
  const PAGE = 50;
  const audit = await db.auditLog.findMany({
    where: { AND: [
      { OR: [{ organisationId }, { branchId: { in: branchIds.map((branch) => branch.id) } }] },
      ...(after ? [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }] : [])
    ] },
    include: { user: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1
  });
  const branchNames = new Map(branchIds.map((branch) => [branch.id, branch.name]));
  const page = audit.slice(0, PAGE);
  return {
    devices: devices.map((device) => ({
      id: device.id, name: device.name, branchName: device.branch.name, isActive: device.isActive, activated: !!device.activatedAt, lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      diagnostics: (device.diagnostics ?? null) as DeviceDiagnostics | null, diagnosticsAt: device.diagnosticsAt?.toISOString() ?? null,
      operations: { pending: count(device.id, "PENDING"), applied: count(device.id, "APPLIED"), failed: count(device.id, "FAILED"), conflicts: count(device.id, "CONFLICT"), flaggedUnreviewed: flagged.find((row) => row.deviceId === device.id)?._count._all ?? 0 }
    })),
    problems: problems.map((operation) => ({ id: operation.idempotencyKey, deviceName: names.get(operation.deviceId) ?? "", type: operation.entityType, status: operation.status, flags: operation.flags, error: operation.errorMessage, retryCount: operation.retryCount, occurredAt: operation.occurredAt?.toISOString() ?? null, processedAt: operation.processedAt?.toISOString() ?? null })),
    audit: page.map((entry) => ({ id: entry.id, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, userName: entry.user?.name ?? null, branchName: entry.branchId ? branchNames.get(entry.branchId) ?? null : null, metadata: entry.metadata, createdAt: entry.createdAt.toISOString() })),
    nextAuditCursor: audit.length > PAGE ? page.at(-1)!.id : null,
    counts: { products, batches, sales, customers, openIssues: flagged.reduce((sum, row) => sum + row._count._all, 0) }
  };
}

/** The first instant of the Pakistan calendar month containing `at`, and of the month before. */
function pkMonthStarts(at: Date): { thisMonth: Date; lastMonth: Date } {
  const pk = new Date(at.getTime() + 5 * 3_600_000);
  const thisMonth = new Date(Date.UTC(pk.getUTCFullYear(), pk.getUTCMonth(), 1) - 5 * 3_600_000);
  const lastMonth = new Date(Date.UTC(pk.getUTCFullYear(), pk.getUTCMonth() - 1, 1) - 5 * 3_600_000);
  return { thisMonth, lastMonth };
}

export async function collections(now = new Date()): Promise<CollectionsDashboard> {
  const subscriptions = await db.subscription.findMany({ include: { plan: true, organisation: { select: { id: true, name: true, phone: true } } } });
  const { thisMonth, lastMonth } = pkMonthStarts(now);
  const [openInvoices, thisMonthPaid, lastMonthPaid, recent, unmatched, lostEvents] = await Promise.all([
    db.subscriptionInvoice.findMany({ where: { status: "OPEN" }, include: { payments: true } }),
    db.subscriptionPayment.aggregate({ where: { status: "SUCCEEDED", receivedAt: { gte: thisMonth } }, _sum: { amount: true } }),
    db.subscriptionPayment.aggregate({ where: { status: "SUCCEEDED", receivedAt: { gte: lastMonth, lt: thisMonth } }, _sum: { amount: true } }),
    db.subscriptionPayment.findMany({ where: { status: "SUCCEEDED" }, include: paymentInclude, orderBy: { receivedAt: "desc" }, take: 20 }),
    db.subscriptionPayment.findMany({ where: { status: "UNMATCHED" }, include: paymentInclude, orderBy: { receivedAt: "desc" } }),
    db.subscriptionEvent.findMany({ where: { type: "status_changed", toStatus: { in: ["EXPIRED", "CANCELLED"] }, createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } }, select: { subscriptionId: true } })
  ]);
  const counts = emptyCounts();
  let mrr = 0;
  const overdue: CollectionsDashboard["overdue"] = [];
  const dueSoon: CollectionsDashboard["dueSoon"] = [];
  const balanceOf = (organisationId: string) => openInvoices.filter((invoice) => invoice.organisationId === organisationId).reduce((sum, invoice) => sum + Math.max(0, Number(invoice.total) - invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((paid, payment) => paid + Number(payment.amount), 0)), 0);
  for (const subscription of subscriptions) {
    const dates = { isTrial: subscription.isTrial, paidThrough: subscription.paidThrough, cancelledAt: subscription.cancelledAt };
    const state = subscriptionState(dates, now);
    counts[state]++;
    if (state === "ACTIVE") {
      const price = periodPrice({ monthlyPrice: Number(subscription.plan.monthlyPrice), quarterlyDiscountPercent: subscription.plan.quarterlyDiscountPercent, yearlyDiscountPercent: subscription.plan.yearlyDiscountPercent }, subscription.period);
      mrr += price.total / price.months;
    }
    const balance = balanceOf(subscription.organisationId);
    const oldest = openInvoices.filter((invoice) => invoice.organisationId === subscription.organisationId).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
    if (state === "GRACE" || state === "EXPIRED" || (oldest && oldest.dueAt < now)) {
      overdue.push({ organisationId: subscription.organisationId, name: subscription.organisation.name, phone: subscription.organisation.phone, status: state, paidThrough: subscription.paidThrough.toISOString(), balance: roundMoney(balance), oldestDueAt: oldest?.dueAt.toISOString() ?? null, daysOverdue: Math.max(0, -daysUntil(oldest?.dueAt ?? subscription.paidThrough, now)) });
    } else if (renewalDue(dates, now)) {
      dueSoon.push({ organisationId: subscription.organisationId, name: subscription.organisation.name, status: state, paidThrough: subscription.paidThrough.toISOString(), daysLeft: daysUntil(subscription.paidThrough, now) });
    }
  }
  const lost = new Set(lostEvents.map((event) => event.subscriptionId)).size;
  const base = lost + subscriptions.filter((subscription) => subscription.createdAt.getTime() < now.getTime() - 30 * DAY_MS && ["TRIAL", "ACTIVE", "GRACE"].includes(subscriptionState({ isTrial: subscription.isTrial, paidThrough: subscription.paidThrough, cancelledAt: subscription.cancelledAt }, now))).length;
  return {
    generatedAt: now.toISOString(), mrr: roundMoney(mrr),
    collectedThisMonth: Number(thisMonthPaid._sum.amount ?? 0), collectedLastMonth: Number(lastMonthPaid._sum.amount ?? 0),
    outstanding: roundMoney(openInvoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.total) - invoice.payments.filter((payment) => payment.status === "SUCCEEDED").reduce((paid, payment) => paid + Number(payment.amount), 0)), 0)),
    counts, churn30Days: { lost, base, percent: base > 0 ? Math.round(lost / base * 1000) / 10 : null },
    overdue: overdue.sort((a, b) => b.daysOverdue - a.daysOverdue), dueSoon: dueSoon.sort((a, b) => a.daysLeft - b.daysLeft),
    recentPayments: await toPaymentSummaries(recent), unmatchedPayments: await toPaymentSummaries(unmatched)
  };
}

export async function overview(now = new Date()): Promise<AdminOverview> {
  const { thisMonth } = pkMonthStarts(now);
  const [total, suspended, newThisMonth, dashboard, priceReports, priceLists, syncProblems, organisations] = await Promise.all([
    db.organisation.count(),
    db.organisation.count({ where: { isActive: false } }),
    db.organisation.count({ where: { createdAt: { gte: thisMonth } } }),
    collections(now),
    db.priceChangeReport.count({ where: { status: "PENDING", product: { masterProductId: { not: null } } } }),
    db.priceListUpload.count({ where: { status: "REVIEW" } }),
    db.syncOperation.count({ where: { reviewedAt: null, status: { in: ["FAILED", "CONFLICT"] } } }),
    db.organisation.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } }, select: { id: true } })
  ]);
  const onboarding = (await Promise.all(organisations.map((organisation) => checklist(organisation.id, now)))).filter((steps) => steps.some((step) => !step.done)).length;
  const counts = emptyCounts();
  for (const status of STATUSES) counts[status] = dashboard.counts[status];
  return {
    tenants: { total, active: total - suspended, suspended, newThisMonth },
    subscriptions: counts, mrr: dashboard.mrr, collectedThisMonth: dashboard.collectedThisMonth,
    queue: { priceReports, priceLists, unmatchedPayments: dashboard.unmatchedPayments.length, overdueShops: dashboard.overdue.length, syncProblems, onboarding }
  };
}
