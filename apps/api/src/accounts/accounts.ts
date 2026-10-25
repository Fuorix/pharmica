import type { ControlledRegisterEntry, LedgerLine, PayableSummary, Prescription, ReceivableSummary, SaleUnit } from "@pharmica/contracts";
import type { Prisma } from "@pharmica/database/client";
import { ageLedger, ledgerEffect, roundMoney } from "@pharmica/domain";

type Tx = Prisma.TransactionClient;
export type AccountContext = { branchId: string; organisationId: string; userId: string; deviceId?: string; at?: Date };

/** Something the books cannot accept, e.g. a payment of zero or a customer from another branch. */
export class AccountError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type LedgerRow = { type: string; amount: Prisma.Decimal | number; createdAt: Date };

export function toReceivable(customer: { id: string; name: string; phone: string | null; creditLimit: Prisma.Decimal | number | null; isActive: boolean; ledger: LedgerRow[] }, now = new Date()): ReceivableSummary {
  const aged = ageLedger(customer.ledger, now);
  return { id: customer.id, name: customer.name, phone: customer.phone, creditLimit: (customer.creditLimit == null ? null : Number(customer.creditLimit)), isActive: customer.isActive, balance: aged.balance, daysOutstanding: aged.daysOutstanding, buckets: aged.buckets };
}

export function toPayable(supplier: { id: string; name: string; phone: string | null; address: string | null; isActive: boolean; ledger: LedgerRow[] }, now = new Date()): PayableSummary {
  const aged = ageLedger(supplier.ledger, now);
  return { id: supplier.id, name: supplier.name, phone: supplier.phone, address: supplier.address, isActive: supplier.isActive, balance: aged.balance, daysOutstanding: aged.daysOutstanding, buckets: aged.buckets };
}

/** Ledger entries oldest first, with the running balance after each one; returned newest first. */
export function toLedgerLines(entries: Array<LedgerRow & { id: string; note: string | null; user: { name: string } | null; paymentMethod?: string | null; method?: string | null; reference?: string | null }>): LedgerLine[] {
  let balance = 0;
  const lines = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((entry) => {
    const amount = roundMoney(ledgerEffect(entry));
    balance = roundMoney(balance + amount);
    return { id: entry.id, at: entry.createdAt.toISOString(), type: entry.type, amount, balanceAfter: balance, note: entry.note, by: entry.user?.name ?? "System", method: entry.paymentMethod?.toLowerCase() ?? entry.method ?? null, reference: entry.reference ?? null };
  });
  return lines.reverse();
}

function requirePositive(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new AccountError("INVALID_AMOUNT", "The amount must be more than zero");
}

/** A customer pays back credit. Cash taken at a counter is tied to its shift so the drawer reconciles. */
export async function recordCustomerPayment(tx: Tx, context: AccountContext, input: { customerId: string; amount: number; method: "cash" | "card"; shiftId?: string; note?: string }) {
  requirePositive(input.amount);
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, branchId: context.branchId } });
  if (!customer) throw new AccountError("CUSTOMER_NOT_FOUND", "The customer is not in this branch");
  const entry = await tx.customerLedgerEntry.create({
    data: { branchId: context.branchId, customerId: customer.id, userId: context.userId, type: "PAYMENT", amount: roundMoney(input.amount), paymentMethod: input.method === "cash" ? "CASH" : "CARD", deviceId: context.deviceId, shiftId: input.shiftId, note: input.note?.trim() || "Payment received", createdAt: context.at }
  });
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "customer.payment", entityType: "customer", entityId: customer.id, metadata: { amount: input.amount, method: input.method, deviceId: context.deviceId } } });
  return entry;
}

/** Owner correction to what someone owes. Positive adds to the debt, negative reduces it. Always needs a reason. */
export async function adjustCustomer(tx: Tx, context: AccountContext, input: { customerId: string; amount: number; reason: string }) {
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new AccountError("INVALID_AMOUNT", "The adjustment cannot be zero");
  if (!input.reason.trim()) throw new AccountError("REASON_REQUIRED", "A reason is required for every adjustment");
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, branchId: context.branchId } });
  if (!customer) throw new AccountError("CUSTOMER_NOT_FOUND", "The customer is not in this branch");
  const entry = await tx.customerLedgerEntry.create({ data: { branchId: context.branchId, customerId: customer.id, userId: context.userId, type: "ADJUSTMENT", amount: roundMoney(input.amount), note: input.reason.trim() } });
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "customer.adjustment", entityType: "customer", entityId: customer.id, metadata: { amount: input.amount, reason: input.reason } } });
  return entry;
}

export async function recordSupplierPayment(tx: Tx, context: AccountContext, input: { supplierId: string; amount: number; method: "cash" | "bank" | "cheque"; reference?: string; note?: string }) {
  requirePositive(input.amount);
  const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, branchId: context.branchId } });
  if (!supplier) throw new AccountError("SUPPLIER_NOT_FOUND", "The supplier is not in this branch");
  if (input.method !== "cash" && !input.reference?.trim()) throw new AccountError("REFERENCE_REQUIRED", "Enter the cheque number or bank reference");
  const entry = await tx.supplierLedgerEntry.create({ data: { branchId: context.branchId, supplierId: supplier.id, userId: context.userId, type: "PAYMENT", amount: roundMoney(input.amount), method: input.method, reference: input.reference?.trim() || null, note: input.note?.trim() || `Payment to ${supplier.name}` } });
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "supplier.payment", entityType: "supplier", entityId: supplier.id, metadata: { amount: input.amount, method: input.method, reference: input.reference } } });
  return entry;
}

export async function adjustSupplier(tx: Tx, context: AccountContext, input: { supplierId: string; amount: number; reason: string }) {
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new AccountError("INVALID_AMOUNT", "The adjustment cannot be zero");
  if (!input.reason.trim()) throw new AccountError("REASON_REQUIRED", "A reason is required for every adjustment");
  const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, branchId: context.branchId } });
  if (!supplier) throw new AccountError("SUPPLIER_NOT_FOUND", "The supplier is not in this branch");
  const entry = await tx.supplierLedgerEntry.create({ data: { branchId: context.branchId, supplierId: supplier.id, userId: context.userId, type: "ADJUSTMENT", amount: roundMoney(input.amount), note: `${input.reason.trim()} (${supplier.name})` } });
  await tx.auditLog.create({ data: { organisationId: context.organisationId, branchId: context.branchId, userId: context.userId, action: "supplier.adjustment", entityType: "supplier", entityId: supplier.id, metadata: { amount: input.amount, reason: input.reason } } });
  return entry;
}

const unitMap: Record<SaleUnit, "PACK" | "STRIP" | "TABLET"> = { pack: "PACK", strip: "STRIP", tablet: "TABLET" };

/** Writes one register entry per controlled-drug line of a sale. */
export async function recordControlledSale(tx: Tx, context: AccountContext, input: { saleId: string; prescription: Prescription; lines: Array<{ saleLineId: string; productId: string; batchId: string | null; unit: SaleUnit; quantity: number }> }) {
  for (const line of input.lines) {
    await tx.controlledDrugRecord.create({
      data: {
        branchId: context.branchId, userId: context.userId, deviceId: context.deviceId, entryType: "ENTRY", saleId: input.saleId, saleLineId: line.saleLineId, productId: line.productId, batchId: line.batchId,
        unit: unitMap[line.unit], quantity: line.quantity,
        patientName: input.prescription.patientName.trim(), patientPhone: input.prescription.patientPhone?.trim() || null,
        doctorName: input.prescription.doctorName.trim(), doctorRegNo: input.prescription.doctorRegNo?.trim() || null, prescriptionRef: input.prescription.prescriptionRef?.trim() || null,
        createdAt: context.at
      }
    });
  }
}

/**
 * Records that controlled stock came back (a void, or a return of some units). The original entries stay as
 * they are; each gets a REVERSAL entry for what came back.
 */
export async function reverseControlledSale(tx: Tx, context: AccountContext, input: { saleId: string; reason: string; returned?: Map<string, number> }) {
  const entries = await tx.controlledDrugRecord.findMany({ where: { saleId: input.saleId, entryType: "ENTRY" } });
  for (const entry of entries) {
    const quantity = input.returned ? input.returned.get(entry.saleLineId ?? "") ?? 0 : entry.quantity;
    if (quantity <= 0) continue;
    await tx.controlledDrugRecord.create({
      data: {
        branchId: entry.branchId, userId: context.userId, deviceId: context.deviceId, entryType: "REVERSAL", saleId: entry.saleId, saleLineId: entry.saleLineId, reversesId: entry.id, productId: entry.productId, batchId: entry.batchId,
        unit: entry.unit, quantity: -quantity, patientName: entry.patientName, patientPhone: entry.patientPhone, doctorName: entry.doctorName, doctorRegNo: entry.doctorRegNo, prescriptionRef: entry.prescriptionRef,
        notes: input.reason, createdAt: context.at
      }
    });
  }
}

export const registerInclude = {
  product: { include: { masterProduct: true } },
  user: { select: { name: true } },
  sale: { select: { receiptNo: true } }
} satisfies Prisma.ControlledDrugRecordInclude;

export function toRegisterEntry(record: Prisma.ControlledDrugRecordGetPayload<{ include: typeof registerInclude }>, batchNo: string | null): ControlledRegisterEntry {
  return {
    id: record.id,
    at: record.createdAt.toISOString(),
    entryType: record.entryType,
    productName: record.product.masterProduct?.name ?? record.product.name,
    batchNo,
    unit: record.unit.toLowerCase() as SaleUnit,
    quantity: record.quantity,
    patientName: record.patientName,
    patientPhone: record.patientPhone,
    doctorName: record.doctorName,
    doctorRegNo: record.doctorRegNo,
    prescriptionRef: record.prescriptionRef,
    recordedBy: record.user.name,
    receiptNo: record.sale?.receiptNo ?? null,
    reversesId: record.reversesId
  };
}
