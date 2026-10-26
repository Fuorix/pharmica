import type { PosSnapshot } from "@pharmica/contracts";
import { db } from "@pharmica/database/client";
import { ageLedger } from "@pharmica/domain";
import { authenticateDevice } from "../../../../../src/auth/authorization";
import { toRoleName } from "../../../../../src/auth/session";
import { catalogueInclude, toCatalogueProduct } from "../../../../../src/catalogue/catalogue";
import { apiError } from "../../../../../src/lib/api-response";
import { corsOptions, withCors } from "../../../../../src/lib/cors";
import { requireCloudSync, summarize } from "../../../../../src/billing/subscriptions";
import { branchSettings } from "../../../../../src/reports/reports";

export function OPTIONS(request: Request): Response { return corsOptions(request); }

/** Everything an activated counter needs to bill offline: catalogue, stock by batch, customers, and staff. */
export async function GET(request: Request): Promise<Response> {
  const device = await authenticateDevice(request);
  if (!device) return withCors(apiError(401, "DEVICE_NOT_LINKED", "This counter is not linked or has been turned off"), request);
  // Billing never stops on the counter; only cloud sync pauses, and queued work waits for it.
  const paused = await requireCloudSync(device.branch.organisation);
  if (paused) return withCors(paused, request);
  const branchId = device.branchId;
  const now = new Date();

  const [organisation, staff, products, customers, suppliers, subscription] = await Promise.all([
    db.organisation.findUniqueOrThrow({ where: { id: device.branch.organisationId } }),
    db.user.findMany({
      where: { organisationId: device.branch.organisationId, isActive: true, pinHash: { not: null }, role: { in: ["OWNER", "CASHIER"] }, OR: [{ branchId: null }, { branchId }] },
      select: { id: true, name: true, role: true, maxDiscountPercent: true },
      orderBy: { name: "asc" }
    }),
    db.product.findMany({ where: { branchId, isActive: true }, include: catalogueInclude, orderBy: { name: "asc" } }),
    db.customer.findMany({ where: { branchId, isActive: true }, include: { ledger: { select: { type: true, amount: true, createdAt: true } } }, orderBy: { name: "asc" } }),
    db.supplier.findMany({ where: { branchId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.subscription.findUnique({ where: { organisationId: device.branch.organisationId }, include: { plan: true } })
  ]);
  const plan = subscription ? summarize(subscription, now) : null;
  await db.device.update({ where: { id: device.id }, data: { lastSeenAt: now } });

  const settings = branchSettings(device.branch.settings);
  const snapshot: PosSnapshot = {
    generatedAt: now.toISOString(),
    device: { id: device.id, name: device.name, branchId, branchName: device.branch.name },
    organisationName: organisation.name,
    subscription: plan ? { status: plan.status, paidThrough: plan.paidThrough, daysLeft: plan.daysLeft, renewalDue: plan.renewalDue } : undefined,
    receipt: { header: settings.receiptHeader, footer: settings.receiptFooter, address: device.branch.address, phone: device.branch.phone },
    staff: staff.map((member) => ({ id: member.id, name: member.name, role: toRoleName(member.role), maxDiscountPercent: member.role === "OWNER" ? null : member.maxDiscountPercent })),
    products: products.map((product) => toCatalogueProduct(product, now)),
    batches: products.flatMap((product) => product.batches.map((batch) => ({
      id: batch.id,
      productId: product.id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate.toISOString(),
      quantity: batch.quantity,
      retailPrice: Number(batch.retailPrice)
    }))),
    customers: customers.map(({ ledger, ...customer }) => {
      const aged = ageLedger(ledger, now);
      return { id: customer.id, name: customer.name, phone: customer.phone, creditLimit: (customer.creditLimit == null ? null : Number(customer.creditLimit)), balance: aged.balance, daysOutstanding: aged.daysOutstanding };
    }),
    suppliers
  };
  return withCors(Response.json(snapshot, { headers: { "x-api-version": "v1" } }), request);
}
