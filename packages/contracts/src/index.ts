export type UserRole = "owner" | "cashier" | "super-admin";

export interface AuthUser {
  id: string;
  name: string;
  login: string;
  role: UserRole;
  organisationId: string | null;
  branchId: string | null;
  /** Set when the session was opened by PIN on a POS device. */
  deviceId: string | null;
  /** The account was created with a temporary password that must be replaced before anything else. */
  mustChangeCredential?: boolean;
}

export interface LoginRequest {
  login: string;
  credential: string;
}

export interface PinLoginRequest {
  userId: string;
  pin: string;
}

export interface AuthResponse {
  user: AuthUser;
  expiresAt: string;
  /** Bearer token for clients that cannot rely on cookies (the Tauri POS). */
  token?: string;
}

/** Header carrying `<deviceId>.<deviceSecret>` for device-authenticated POS requests. */
export const DEVICE_TOKEN_HEADER = "x-device-token";

export interface ActivateDeviceRequest {
  activationCode: string;
}

export interface ActivateDeviceResponse {
  device: { id: string; name: string; branchId: string; branchName: string };
  /** `<deviceId>.<secret>`; shown once, stored by the POS. */
  deviceToken: string;
}

export interface DeviceUser {
  id: string;
  name: string;
  role: UserRole;
}

export type SubscriptionState = "active" | "grace" | "expired";

export interface HealthResponse {
  status: "ok";
  service: "pharmica-api";
  timestamp: string;
}

export type SaleUnit = "pack" | "strip" | "tablet";
export type ProductCategory = "medicine" | "cosmetic" | "surgical" | "baby" | "general";

export interface CatalogueProduct {
  id: string;
  branchId: string;
  masterProductId: string | null;
  name: string;
  brand: string | null;
  generic: string | null;
  company: string | null;
  barcode: string | null;
  category: ProductCategory;
  /** Strips (or bottles, tubes) per pack. */
  unitsPerPack: number;
  tabletsPerStrip: number;
  sellableUnits: SaleUnit[];
  officialRetailPrice: number | null;
  retailPriceOverride: number | null;
  /** Pack price of the batch that sells next (earliest expiry), after any shop override; null when out of stock. */
  sellingPrice: number | null;
  /** Sellable stock in base units (tablets, or packs for unsplittable items). */
  stockQuantity: number;
  nearestExpiry: string | null;
  isPrescriptionOnly: boolean;
  isControlled: boolean;
  rackLocation: string | null;
  lowStockThreshold: number;
  isShopSpecific: boolean;
}

/** A master-list medicine this branch does not carry yet. */
export interface MasterProductSummary {
  id: string;
  name: string;
  brand: string | null;
  generic: string | null;
  company: string | null;
  dosageForm: string | null;
  strength: string | null;
  barcode: string | null;
  unitsPerPack: number;
  tabletsPerStrip: number;
  officialRetailPrice: number | null;
  isPrescriptionOnly: boolean;
  isControlled: boolean;
  /** Set on a duplicate merged into another entry; counters drop it from their stored list. */
  mergedIntoId?: string;
}

export interface CatalogueSearchResponse {
  products: CatalogueProduct[];
  /** Only returned for a search: master-list matches not yet in this branch. */
  masterMatches: MasterProductSummary[];
}

export interface MasterPriceEntry {
  id: string;
  price: number;
  effectiveFrom: string;
  source: string;
  reference: string | null;
  createdAt: string;
}
export type PaymentMethod = "cash" | "card" | "credit";

export interface CreateSaleRequest {
  branchId: string;
  customerId?: string;
  paymentMethod: PaymentMethod;
  discount?: number;
  lines: Array<{
    productId: string;
    quantity: number;
    unit: SaleUnit;
    unitPrice?: number;
  }>;
}

export interface SaleSummary {
  id: string;
  branchId: string;
  subtotal: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  status: "completed" | "voided" | "returned";
  createdAt: string;
  /** One line per batch sold from; returned when a sale is created. */
  lines?: Array<{ productId: string; batchId: string | null; quantity: number; unit: SaleUnit; unitPrice: number; lineTotal: number }>;
}

export type StockMovementType = "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF" | "DAMAGE" | "EXPIRY" | "RETURN_TO_SUPPLIER";

export interface ReceivePurchaseLine {
  lineId?: string;
  /** A product the branch already stocks, or... */
  productId?: string;
  /** ...a master-list medicine, which is added to the branch on receipt. */
  masterProductId?: string;
  /** Client-chosen id for a new batch, so an offline counter can sell it before it syncs. */
  batchId?: string;
  batchNo: string;
  /** YYYY-MM-DD */
  expiryDate: string;
  /** Packs paid for. */
  quantity: number;
  /** Free (bonus) packs. */
  bonusQuantity: number;
  /** Invoice price per pack, before discounts. */
  costPrice: number;
  /** Trade discount on this line, in PKR. */
  discount: number;
  /** Retail price printed on the pack. */
  retailPrice: number;
  serialNumber?: string;
}

export interface ReceivePurchaseRequest {
  branchId: string;
  purchaseId?: string;
  supplier: { id?: string; name: string; phone?: string };
  invoiceNumber?: string;
  /** YYYY-MM-DD */
  invoiceDate?: string;
  /** Discount on the whole invoice, in PKR. */
  invoiceDiscount: number;
  lines: ReceivePurchaseLine[];
}

export interface PurchaseSummary {
  id: string;
  supplier: { id: string; name: string };
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receivedAt: string;
  receivedBy: string;
  subtotal: number;
  lineDiscount: number;
  invoiceDiscount: number;
  total: number;
  bonusPacks: number;
  lines: Array<{ productId: string; name: string; batchNo: string; expiryDate: string; quantity: number; bonusQuantity: number; costPrice: number; discount: number; effectiveCost: number; retailPrice: number }>;
}

export interface ReceivePurchaseResponse {
  purchase: PurchaseSummary;
  /** Things the receiver should know, e.g. a price that differs from the master list (reported automatically). */
  warnings: string[];
}

export type BatchStatus = "ok" | "near-expiry" | "expired";

export interface InventoryItem {
  productId: string;
  name: string;
  generic: string | null;
  company: string | null;
  barcode: string | null;
  rackLocation: string | null;
  unitsPerPack: number;
  tabletsPerStrip: number;
  /** Alert level in packs; 0 means no alert. */
  lowStockThreshold: number;
  /** Base units that can be sold. */
  sellable: number;
  nearExpiry: number;
  expired: number;
  nearestExpiry: string | null;
  lowStock: boolean;
  /** Stock value at each batch's effective cost and at its retail price. */
  valueAtCost: number;
  valueAtRetail: number;
  batches: Array<{ id: string; batchNo: string; expiryDate: string; quantity: number; retailPrice: number; costPrice: number | null; status: BatchStatus }>;
}

export type StockAdjustmentType = "WRITE_OFF" | "DAMAGE" | "EXPIRY" | "ADJUSTMENT";

export interface CustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  /** Most this customer may owe on credit: 0 means no credit allowed, null means no limit. */
  creditLimit: number | null;
  balance: number;
}

export interface SyncOperationRequest {
  idempotencyKey: string;
  deviceId: string;
  entityType: "sale" | "stock-adjustment" | "customer-payment";
  entityId: string;
  version?: number;
  payload: unknown;
}

export interface SyncChangeResponse {
  cursor: number;
  entityType: string;
  entityId: string;
  version: number;
  payload: unknown;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Offline POS: the device downloads a snapshot, works locally, and uploads operations.
// ---------------------------------------------------------------------------

export interface PosBatch {
  id: string;
  productId: string;
  batchNo: string;
  expiryDate: string;
  /** Base units on hand at the server when the snapshot was taken. */
  quantity: number;
  /** Printed retail price per pack. */
  retailPrice: number;
}

export interface PosStaffMember extends DeviceUser {
  /** Largest bill discount in percent; null means no limit (owners). */
  maxDiscountPercent: number | null;
}

export interface PosCustomer {
  id: string;
  name: string;
  phone: string | null;
  /** Most this customer may owe on credit: 0 means no credit allowed, null means no limit. */
  creditLimit: number | null;
  /** Amount owed according to the server. */
  balance: number;
  /** Days since the oldest unpaid credit sale (0 when nothing is owed). */
  daysOutstanding: number;
}

export interface PosSnapshot {
  generatedAt: string;
  device: ActivateDeviceResponse["device"];
  organisationName: string;
  staff: PosStaffMember[];
  products: CatalogueProduct[];
  batches: PosBatch[];
  customers: PosCustomer[];
  suppliers: Array<{ id: string; name: string }>;
  /** What the owner set for printed receipts at this branch. Older snapshots may not have it. */
  receipt?: PosReceiptSettings;
  /** For renewal reminders on the counter. */
  subscription?: { status: SubscriptionStatus; paidThrough: string; daysLeft: number; renewalDue: boolean };
}

export interface PosReceiptSettings {
  header: string;
  footer: string;
  address: string | null;
  phone: string | null;
}

export interface PosSaleLine {
  lineId: string;
  productId: string;
  batchId: string;
  unit: SaleUnit;
  quantity: number;
  unitPrice: number;
  /** Item discount on this line in PKR. */
  discount: number;
}

export interface PosSalePayload {
  saleId: string;
  receiptNo: string;
  shiftId?: string;
  customerId?: string;
  paymentMethod: PaymentMethod;
  billDiscount: number;
  /** The total the customer was charged, for cross-checking. */
  total: number;
  lines: PosSaleLine[];
  /** Required when the bill has a controlled (scheduled) drug: recorded in the narcotics register. */
  prescription?: Prescription;
}

export interface Prescription {
  patientName: string;
  patientPhone?: string;
  doctorName: string;
  /** PMDC or other registration number of the prescribing doctor. */
  doctorRegNo?: string;
  prescriptionRef?: string;
}

interface PosOperationBase<Type extends string, Payload> {
  /** Client-generated id; the server applies each operation once. */
  id: string;
  type: Type;
  userId: string;
  occurredAt: string;
  payload: Payload;
}

export type PosOperation =
  | PosOperationBase<"shift.open", { shiftId: string; openingCash: number }>
  | PosOperationBase<"shift.close", { shiftId: string; closingCash: number; report: unknown }>
  | PosOperationBase<"customer.create", { customerId: string; name: string; phone?: string; creditLimit?: number | null }>
  | PosOperationBase<"sale", PosSalePayload>
  | PosOperationBase<"sale.void", { saleId: string; reason: string }>
  | PosOperationBase<"sale.return", { returnId: string; saleId: string; reason: string; refundMethod: PaymentMethod; lines: Array<{ saleLineId: string; quantity: number }> }>
  | PosOperationBase<"purchase.receive", Omit<ReceivePurchaseRequest, "branchId" | "purchaseId"> & { purchaseId: string }>
  /** `quantity` is in base units; negative removes stock. */
  | PosOperationBase<"stock.adjust", { adjustmentId: string; batchId: string; type: StockAdjustmentType; quantity: number; reason: string }>
  /** `expected` is what the counter showed when counting; the difference is applied, so sales elsewhere are not undone. */
  | PosOperationBase<"stock.count", { countId: string; reason: string; lines: Array<{ batchId: string; expected: number; counted: number }> }>
  | PosOperationBase<"product.update", { productId: string; rackLocation?: string | null; lowStockThreshold?: number }>
  /** A customer pays back credit (udhaar) at the counter. Cash counts in the shift's drawer. */
  | PosOperationBase<"customer.payment", { paymentId: string; customerId: string; amount: number; method: "cash" | "card"; shiftId?: string; note?: string }>
  | PosOperationBase<"audit", { action: string; entityType: string; entityId?: string; metadata?: Record<string, unknown> }>;

export type PosOperationType = PosOperation["type"];

export interface PosSyncResult {
  id: string;
  /** retry: the server had a problem (not the counter's fault); keep the operation queued and try again later. */
  status: "applied" | "duplicate" | "failed" | "retry";
  error?: { code: string; message: string };
  /** Accepted, but something needs the owner's attention (e.g. stock oversold between counters). */
  flags?: string[];
}

// ---------------------------------------------------------------------------
// Credit (receivables), suppliers (payables), and the narcotics register.
// ---------------------------------------------------------------------------

export interface AgeBuckets {
  current: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface ReceivableSummary {
  id: string;
  name: string;
  phone: string | null;
  /** Most this customer may owe on credit: 0 means no credit allowed, null means no limit. */
  creditLimit: number | null;
  isActive: boolean;
  balance: number;
  daysOutstanding: number;
  buckets: AgeBuckets;
}

export interface PayableSummary {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  isActive: boolean;
  balance: number;
  daysOutstanding: number;
  buckets: AgeBuckets;
}

export interface LedgerLine {
  id: string;
  at: string;
  type: string;
  /** Effect on the balance: positive adds to what is owed. */
  amount: number;
  balanceAfter: number;
  note: string | null;
  by: string;
  method: string | null;
  reference: string | null;
}

export interface ControlledRegisterEntry {
  id: string;
  at: string;
  entryType: "ENTRY" | "REVERSAL";
  productName: string;
  batchNo: string | null;
  unit: SaleUnit;
  /** Negative for a reversal. */
  quantity: number;
  patientName: string;
  patientPhone: string | null;
  doctorName: string;
  doctorRegNo: string | null;
  prescriptionRef: string | null;
  recordedBy: string;
  receiptNo: string | null;
  reversesId: string | null;
}

// ---------------------------------------------------------------------------
// Sync recovery: master list downloads, counter health, and sync issues.
// ---------------------------------------------------------------------------

/** One page of the master list, oldest change first. Pass `nextCursor` back to resume where the last page ended. */
export interface MasterListPage {
  products: MasterProductSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** What a counter reports about its own sync health, for the owner and Pharmica support. */
export interface DeviceDiagnostics {
  appVersion: string;
  reportedAt: string;
  pending: number;
  failed: number;
  /** When the oldest operation still waiting to upload was made. */
  oldestPendingAt: string | null;
  lastSyncAt: string | null;
  lastSnapshotAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  masterProducts: number;
  localSales: number;
}

export interface DeviceHealth {
  id: string;
  name: string;
  branchId: string;
  isActive: boolean;
  lastSeenAt: string | null;
  diagnostics: DeviceDiagnostics | null;
  diagnosticsAt: string | null;
}

/** An uploaded operation the owner should look at: rejected by the server, or accepted with flags. */
export interface SyncIssue {
  id: string;
  deviceId: string;
  deviceName: string;
  type: string;
  status: "rejected" | "flagged" | "retrying";
  flags: string[];
  error: string | null;
  occurredAt: string | null;
  processedAt: string | null;
  userName: string | null;
  /** Short description, e.g. "Receipt 7K2Q-000012, PKR 930.00". */
  summary: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

// ---------------------------------------------------------------------------
// Owner reports. Every figure comes from a named query over a stated period (Pakistan time).
// ---------------------------------------------------------------------------

export interface ReportTotals {
  /** Money received after all discounts, less returns. */
  revenue: number;
  /** Cost of the goods sold whose cost is known. */
  cost: number;
  grossProfit: number;
  marginPercent: number | null;
  discounts: number;
  returns: number;
  /** Revenue on early sales whose cost is unknown; left out of profit. */
  revenueWithoutCost: number;
  bills: number;
}

export interface BranchSettings {
  receiptHeader: string;
  receiptFooter: string;
  /** Batches expiring within this many days count as near expiry. */
  nearExpiryDays: number;
  /** Credit owed for longer than this many days counts as overdue. */
  overdueDays: number;
  /** A discount of at least this percent of the bill raises an alert. */
  largeDiscountPercent: number;
}

export type AlertKind = "void" | "return" | "large_discount" | "discount_over_limit" | "line_deleted" | "drawer_opened" | "missing_prescription" | "oversold" | "stock_written_off" | "failed_logins";

export interface AlertItem {
  id: string;
  at: string;
  kind: AlertKind;
  severity: "high" | "medium" | "low";
  branchId: string | null;
  branchName: string | null;
  userName: string | null;
  description: string;
}

export interface DashboardBranch {
  branchId: string;
  branchName: string;
  today: ReportTotals;
  /** Cash that should be in the drawers of open shifts; null when no shift is open. */
  cashInDrawer: number | null;
  openShifts: number;
  lowStock: number;
  nearExpiry: number;
  /** Counters with work not yet uploaded: today's figures may still change. */
  unsyncedCounters: number;
  pendingUploads: number;
}

export interface DashboardResponse {
  day: string;
  generatedAt: string;
  totals: ReportTotals;
  branches: DashboardBranch[];
  topItems: Array<{ productId: string; name: string; revenue: number; grossProfit: number }>;
  last7Days: Array<{ day: string; revenue: number; grossProfit: number }>;
  alerts: AlertItem[];
}

export interface SalesReportRow extends ReportTotals {
  key: string;
  label: string;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: number;
  costOfGoods: number;
  grossProfit: number;
  /** Cost of stock written off, damaged, or expired in the period. */
  stockLosses: number;
  expenses: number;
  expensesByCategory: Array<{ category: string; amount: number }>;
  netProfit: number;
  revenueWithoutCost: number;
}

export interface CashBookDay {
  day: string;
  cashSales: number;
  repayments: number;
  refunds: number;
  expenses: number;
  supplierPayments: number;
  /** Cash in minus cash out for the day. */
  net: number;
}

export interface StockHealthItem {
  productId: string;
  name: string;
  company: string | null;
  /** Sellable stock in base units, and units per pack to show it in packs. */
  sellable: number;
  unitsPerPack: number;
  valueAtCost: number;
  lastSoldAt: string | null;
  /** Average base units sold per day over the last 30 days. */
  avgDailySold: number;
  /** How many days the stock lasts at that rate; null when nothing sold. */
  daysOfCover: number | null;
  suggestedPacks: number;
  reason: "dead" | "reorder";
}

export interface PriceUpdate {
  productId: string;
  name: string;
  masterProductId: string;
  oldPrice: number | null;
  newPrice: number;
  effectiveFrom: string;
  source: string;
  reference: string | null;
  scheduled: boolean;
  shopPrice: number | null;
  /** Packs on the shelf still printed with an older price. */
  packsAtOtherPrices: number;
}

export interface ShiftSummary {
  id: string;
  branchId: string;
  deviceName: string | null;
  userName: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  closingCash: number | null;
  expectedCash: number | null;
  variance: number | null;
  bills: number;
  revenue: number;
}

export interface ExpenseItem {
  id: string;
  branchId: string;
  category: string;
  amount: number;
  paidFrom: "cash" | "bank";
  note: string | null;
  spentAt: string;
  recordedBy: string;
}

// ---------- subscriptions (M9) ----------

export type SubscriptionStatus = "TRIAL" | "ACTIVE" | "GRACE" | "EXPIRED" | "CANCELLED";
export type BillingPeriod = "MONTHLY" | "QUARTERLY" | "YEARLY";
export type SubscriptionPaymentMethod = "CASH" | "BANK_TRANSFER" | "JAZZCASH" | "EASYPAISA" | "RAAST";
export type PlanFeature = "reports" | "accounting" | "mobile";

export interface PlanSummary {
  id: string;
  code: string;
  name: string;
  monthlyPrice: number;
  quarterlyDiscountPercent: number;
  yearlyDiscountPercent: number;
  maxBranches: number | null;
  maxDevices: number | null;
  features: string[];
  trialDays: number;
  isActive: boolean;
}

export interface SubscriptionAccessFlags {
  billing: true;
  export: true;
  payments: true;
  sync: boolean;
  reports: boolean;
  mobile: boolean;
  manage: boolean;
}

export interface SubscriptionSummary {
  status: SubscriptionStatus;
  isTrial: boolean;
  plan: PlanSummary;
  period: BillingPeriod;
  paidThrough: string;
  /** When grace mode ends if nothing is paid. */
  graceEndsAt: string;
  /** Whole days until the paid-through date (negative once it has passed). */
  daysLeft: number;
  renewalDue: boolean;
  access: SubscriptionAccessFlags;
  /** Features of the plan the shop is on. */
  features: string[];
}

export interface InvoiceSummary {
  id: string;
  number: string;
  organisationId: string;
  organisationName?: string;
  planName: string;
  period: BillingPeriod;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  discount: number;
  total: number;
  /** Total less successful payments. */
  balance: number;
  status: "OPEN" | "PAID" | "VOID";
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
}

export interface PaymentSummary {
  id: string;
  organisationId: string | null;
  organisationName?: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  method: SubscriptionPaymentMethod;
  status: "SUCCEEDED" | "FAILED" | "UNMATCHED";
  amount: number;
  reference: string | null;
  providerTransactionId: string | null;
  note: string | null;
  receivedAt: string;
  recordedBy: string | null;
}

export interface BillingOverview {
  subscription: SubscriptionSummary;
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  plans: PlanSummary[];
  /** Online methods the server has credentials for; empty until payment providers are configured. */
  onlineMethods: SubscriptionPaymentMethod[];
  /** How to pay by cash or bank transfer. */
  payInstructions: string;
}

export interface SubscriptionEventItem {
  id: string;
  type: string;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

// ---------- super-admin (M8) ----------

export type MigrationStatus = "NOT_STARTED" | "IN_PROGRESS" | "DONE" | "NOT_NEEDED";

export interface TenantListItem {
  id: string;
  name: string;
  city: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  branches: number;
  devices: number;
  activeDevices: number;
  status: SubscriptionStatus | null;
  planName: string | null;
  paidThrough: string | null;
  openBalance: number;
  lastSeenAt: string | null;
  onboardingDone: number;
  onboardingTotal: number;
}

export interface OnboardingStep {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
}

export interface TenantDetail {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  city: string | null;
  isActive: boolean;
  createdAt: string;
  migrationStatus: MigrationStatus;
  migrationNote: string | null;
  branches: Array<{ id: string; name: string; address: string | null; phone: string | null }>;
  users: Array<{ id: string; name: string; login: string; role: UserRole; branchId: string | null; isActive: boolean; hasPin: boolean; mustChangeCredential: boolean; lastLoginAt: string | null }>;
  devices: Array<{ id: string; name: string; branchId: string; activationCode: string | null; activatedAt: string | null; isActive: boolean; lastSeenAt: string | null }>;
  subscription: SubscriptionSummary | null;
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  events: SubscriptionEventItem[];
  checklist: OnboardingStep[];
}

export interface CreateTenantRequest {
  pharmacyName: string;
  contactName: string;
  phone?: string;
  city?: string;
  branchName: string;
  branchAddress?: string;
  ownerName: string;
  ownerLogin: string;
  planCode: string;
  period?: BillingPeriod;
  /** Defaults to the plan trial length; 0 starts unpaid with an invoice due now. */
  trialDays?: number;
  counters?: number;
}

export interface CreateTenantResponse {
  tenant: TenantDetail;
  /** Shown once, to hand to the owner; they must change it at first sign-in. */
  temporaryPassword: string;
}

export interface SupportDevice {
  id: string;
  name: string;
  branchName: string;
  isActive: boolean;
  activated: boolean;
  lastSeenAt: string | null;
  diagnostics: DeviceDiagnostics | null;
  diagnosticsAt: string | null;
  operations: { pending: number; applied: number; failed: number; conflicts: number; flaggedUnreviewed: number };
}

export interface SupportOperation {
  id: string;
  deviceName: string;
  type: string;
  status: string;
  flags: string[];
  error: string | null;
  retryCount: number;
  occurredAt: string | null;
  processedAt: string | null;
}

export interface SupportAuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userName: string | null;
  branchName: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface SupportView {
  devices: SupportDevice[];
  problems: SupportOperation[];
  audit: SupportAuditEntry[];
  /** Cursor for the next audit page, or null at the end. */
  nextAuditCursor: string | null;
  counts: { products: number; batches: number; sales: number; customers: number; openIssues: number };
}

export interface CollectionsDashboard {
  generatedAt: string;
  /** Monthly recurring revenue of paying subscriptions (not trials), normalised to one month. */
  mrr: number;
  collectedThisMonth: number;
  collectedLastMonth: number;
  outstanding: number;
  counts: Record<SubscriptionStatus, number>;
  /** Shops that stopped (expired or cancelled) in the last 30 days, as a percent of those that could have. */
  churn30Days: { lost: number; base: number; percent: number | null };
  overdue: Array<{ organisationId: string; name: string; phone: string | null; status: SubscriptionStatus; paidThrough: string; balance: number; oldestDueAt: string | null; daysOverdue: number }>;
  dueSoon: Array<{ organisationId: string; name: string; status: SubscriptionStatus; paidThrough: string; daysLeft: number }>;
  recentPayments: PaymentSummary[];
  unmatchedPayments: PaymentSummary[];
}

export interface ShopPriceReportGroup {
  /** masterProductId:newPrice */
  key: string;
  masterProductId: string;
  name: string;
  company: string | null;
  officialPrice: number | null;
  reportedPrice: number;
  shops: number;
  reports: number;
  firstReportedAt: string;
  lastReportedAt: string;
  examples: Array<{ branchName: string; organisationName: string; batchNo: string | null; supplier: string | null; invoiceNumber: string | null }>;
}

export interface PriceListUploadSummary {
  id: string;
  source: string;
  reference: string;
  fileName: string | null;
  effectiveFrom: string;
  status: "REVIEW" | "PUBLISHED" | "REJECTED";
  uploadedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  counts: { rows: number; matched: number; unchanged: number; notFound: number; ambiguous: number; invalid: number; approved: number };
}

export interface PriceListRowItem {
  id: string;
  line: number;
  name: string;
  barcode: string | null;
  registrationNo: string | null;
  price: number | null;
  masterProductId: string | null;
  masterName: string | null;
  currentPrice: number | null;
  match: "MATCHED" | "UNCHANGED" | "NOT_FOUND" | "AMBIGUOUS" | "INVALID";
  approved: boolean;
  problem: string | null;
}

export interface DuplicateCandidate {
  reason: string;
  products: Array<{ id: string; name: string; generic: string | null; company: string | null; strength: string | null; barcode: string | null; drapRegistrationNo: string | null; unitsPerPack: number; tabletsPerStrip: number; officialRetailPrice: number | null; shops: number }>;
}

export interface AdminOverview {
  tenants: { total: number; active: number; suspended: number; newThisMonth: number };
  subscriptions: Record<SubscriptionStatus, number>;
  mrr: number;
  collectedThisMonth: number;
  queue: { priceReports: number; priceLists: number; unmatchedPayments: number; overdueShops: number; syncProblems: number; onboarding: number };
}

// ---------- data migration (M10) ----------

export type ImportKind = "STOCK" | "CUSTOMERS" | "SUPPLIERS";
export type ImportStatus = "MAPPING" | "REVIEW" | "COMMITTED" | "CANCELLED";
export type ImportRowStatus = "READY" | "NEEDS_REVIEW" | "INVALID" | "SKIPPED" | "COMMITTED";

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}

export interface ImportCounts {
  ready: number;
  needsReview: number;
  invalid: number;
  skipped: number;
  committed: number;
}

export interface ImportJobSummary {
  id: string;
  kind: ImportKind;
  kindLabel: string;
  status: ImportStatus;
  fileName: string;
  organisationId: string;
  branchId: string;
  branchName: string;
  rowCount: number;
  counts: ImportCounts;
  createdBy: string;
  createdAt: string;
  committedBy: string | null;
  committedAt: string | null;
  lastError: string | null;
  /** After commit: what was created. */
  summary: Record<string, number> | null;
}

export interface ImportCandidate {
  id: string;
  name: string;
  company: string | null;
  packing: string;
  officialRetailPrice: number | null;
  score: number;
}

export interface ImportRowItem {
  id: string;
  line: number;
  status: ImportRowStatus;
  problems: string[];
  action: string | null;
  raw: Record<string, string>;
  data: Record<string, unknown> | null;
  masterProductId: string | null;
  masterName: string | null;
  productId: string | null;
  productName: string | null;
  score: number | null;
  candidates: ImportCandidate[];
  decidedBy: string | null;
}

export interface ImportJobDetail {
  job: ImportJobSummary;
  headers: string[];
  columnMap: Record<string, string>;
  fields: ImportField[];
  rows: ImportRowItem[];
  /** Rows matching the filter, for paging. */
  total: number;
}

export interface ImportDecision {
  rowId: string;
  /** STOCK: MASTER, EXISTING, NEW, or SKIP. CUSTOMERS and SUPPLIERS: CREATE or SKIP. */
  action: string;
  masterProductId?: string;
  productId?: string;
}
