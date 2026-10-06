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
  status: "applied" | "duplicate" | "failed";
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
