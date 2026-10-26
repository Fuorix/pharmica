import type { CatalogueProduct, PaymentMethod, PosBatch, PosCustomer, PosOperation, PosSnapshot, PosSyncResult, Prescription, SaleUnit } from "@pharmica/contracts";
import type { PurchaseTotals, ShiftReport } from "@pharmica/domain";

/** A change this counter made that the server has not confirmed yet. */
export interface QueuedOperation {
  /** Zero-padded sequence number; the outbox uploads in this order. */
  key: string;
  operation: PosOperation;
  /**
   * pending: not yet accepted by the server. failed: rejected. confirmed: accepted, but kept (with its effects)
   * until a snapshot taken after `confirmedAt` arrives, so stock never jumps back in between.
   */
  status: "pending" | "failed" | "confirmed";
  confirmedAt?: string;
  error?: PosSyncResult["error"];
  attempts: number;
  /** Stock moved by this operation, so local stock stays right until the server confirms it. */
  stockEffects: Array<{ batchId: string; delta: number }>;
  /** Change to what a customer owes. */
  balanceEffects: Array<{ customerId: string; delta: number }>;
  /** Batches created by this operation (stock received), sellable before the server confirms them. */
  newBatches?: PosBatch[];
  /** Products this branch started stocking (a master-list medicine received for the first time). */
  newProducts?: CatalogueProduct[];
  /** Rack location or low-stock alert changes. */
  productChanges?: Array<{ productId: string; rackLocation?: string | null; lowStockThreshold?: number }>;
}

export interface LocalPurchase {
  id: string;
  receivedAt: string;
  userName: string;
  supplierName: string;
  invoiceNumber?: string;
  totals: Omit<PurchaseTotals, "lines">;
  lines: Array<{ name: string; batchNo: string; expiryDate: string; quantity: number; bonusQuantity: number; costPrice: number; discount: number; retailPrice: number; effectiveCost: number }>;
  warnings: string[];
}

export interface LocalSaleLine {
  lineId: string;
  productId: string;
  name: string;
  batchId: string;
  batchNo: string;
  unit: SaleUnit;
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
  baseUnits: number;
}

export interface LocalReturn {
  returnId: string;
  at: string;
  userId: string;
  userName: string;
  reason: string;
  method: PaymentMethod;
  amount: number;
  lines: Array<{ saleLineId: string; quantity: number; amount: number }>;
}

export interface LocalSale {
  id: string;
  receiptNo: string;
  createdAt: string;
  userId: string;
  userName: string;
  shiftId: string;
  customerId?: string;
  customerName?: string;
  paymentMethod: PaymentMethod;
  lines: LocalSaleLine[];
  subtotal: number;
  itemDiscount: number;
  billDiscount: number;
  discount: number;
  total: number;
  cashReceived?: number;
  change?: number;
  status: "completed" | "voided" | "returned";
  /** Recorded for bills with a controlled (scheduled) drug. */
  prescription?: Prescription;
  voidReason?: string;
  voidedAt?: string;
  returns: LocalReturn[];
}

/** A credit (udhaar) repayment taken at this counter. */
export interface LocalPayment {
  id: string;
  at: string;
  shiftId?: string;
  customerId: string;
  customerName: string;
  amount: number;
  method: "cash" | "card";
  userName: string;
  /** What the customer still owes after this payment (as this counter sees it). */
  balanceAfter: number;
}

export interface LocalShift {
  id: string;
  userId: string;
  userName: string;
  openedAt: string;
  openingCash: number;
  closedAt?: string;
  closingCash?: number;
  report?: ShiftReport;
}


export interface PosSettings {
  paperWidth: 58 | 80;
}

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
  lastSnapshotAt: string | null;
  error: string | null;
  /** Sync attempts that failed in a row; drives the backoff. */
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  /** Master-list medicines stored on this counter for offline receiving. */
  masterProducts: number;
  /** Why the server is not taking uploads (lapsed subscription or suspended pharmacy); billing carries on. */
  paused: string | null;
}

/** What the counter works from: the last server snapshot adjusted by everything not yet confirmed. */
export interface EffectiveState {
  catalogue: CatalogueProduct[];
  customers: PosCustomer[];
}

export type { PosSnapshot };
