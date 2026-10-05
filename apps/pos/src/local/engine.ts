import type { CatalogueProduct, MasterProductSummary, PaymentMethod, PosBatch, PosCustomer, PosOperation, PosSnapshot, PosStaffMember, PosSyncResult, ReceivePurchaseLine, StockAdjustmentType } from "@pharmica/contracts";
import { billTotals, computeShiftReport, discountWithinLimit, formatReceiptNo, NEAR_EXPIRY_DAYS, priceCart, purchaseTotals, refundFor, roundMoney, sellableUnits, type CartItem, type CartProblem } from "@pharmica/domain";
import type { Entry, LocalDb } from "./db";
import { workingStock, type WorkingStock } from "./state";
import type { HeldBill, LocalPurchase, LocalReturn, LocalSale, LocalShift, PosSettings, QueuedOperation, SyncStatus } from "./types";

export interface ReceiveInput {
  supplierId?: string;
  supplierName: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  invoiceDiscount: number;
  lines: Array<{ productId?: string; master?: MasterProductSummary; batchNo: string; expiryDate: string; quantity: number; bonusQuantity: number; costPrice: number; discount: number; retailPrice: number; serialNumber?: string }>;
}

/** A branch product for a master-list medicine the branch is stocking for the first time. */
function productFromMaster(id: string, master: MasterProductSummary, branchId: string): CatalogueProduct {
  const structure = { stripsPerPack: master.unitsPerPack, tabletsPerStrip: master.tabletsPerStrip };
  return {
    id, branchId, masterProductId: master.id, name: master.name, brand: master.brand, generic: master.generic, company: master.company, barcode: master.barcode, category: "medicine",
    unitsPerPack: master.unitsPerPack, tabletsPerStrip: master.tabletsPerStrip, sellableUnits: sellableUnits(structure), officialRetailPrice: master.officialRetailPrice, retailPriceOverride: null,
    sellingPrice: null, stockQuantity: 0, nearestExpiry: null, isPrescriptionOnly: master.isPrescriptionOnly, isControlled: master.isControlled, rackLocation: null, lowStockThreshold: 0, isShopSpecific: false
  };
}

/** The server is unreachable; the counter keeps working and retries later. */
export class OfflineError extends Error {}
/** The owner deactivated or reset this counter. */
export class DeviceRevokedError extends Error {}

export interface Transport {
  snapshot(): Promise<PosSnapshot>;
  push(operations: PosOperation[]): Promise<PosSyncResult[]>;
  searchMaster(query: string): Promise<MasterProductSummary[]>;
}

/** A refusal the cashier must see, e.g. not enough stock or a discount above their limit. */
export class PosError extends Error {
  constructor(message: string, readonly problems: CartProblem[] = []) {
    super(message);
  }
}

export interface EngineState {
  snapshot: PosSnapshot | null;
  stock: WorkingStock | null;
  outbox: QueuedOperation[];
  sales: LocalSale[];
  held: HeldBill[];
  purchases: LocalPurchase[];
  shift: LocalShift | null;
  settings: PosSettings;
  sync: SyncStatus;
  deviceRevoked: boolean;
}

const RECENT_SALES = 500;
const SYNC_BATCH = 50;
const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/**
 * The counter's brain. Every action is saved to the local database first, so billing never waits on the
 * network; the outbox uploads to the server in the background and the snapshot refreshes after each upload.
 */
export class PosEngine {
  private listeners = new Set<() => void>();
  private state: EngineState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  private constructor(private db: LocalDb, private transport: Transport, private deviceId: string, initial: EngineState) {
    this.state = initial;
  }

  static async open(db: LocalDb, transport: Transport, deviceId: string): Promise<PosEngine> {
    const engine = new PosEngine(db, transport, deviceId, {
      snapshot: null, stock: null, outbox: [], sales: [], held: [], purchases: [], shift: null, settings: { paperWidth: 80 }, deviceRevoked: false,
      sync: { online: typeof navigator === "undefined" ? true : navigator.onLine, syncing: false, pending: 0, failed: 0, lastSyncAt: null, lastSnapshotAt: null, error: null }
    });
    await engine.reload();
    return engine;
  }

  // ----- state for React (useSyncExternalStore) -----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = () => this.state;

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async reload() {
    const [snapshot, outbox, sales, held, shift, settings, localCustomers, lastSyncAt, purchases] = await Promise.all([
      this.db.get<PosSnapshot>("meta", "snapshot"),
      this.db.all<QueuedOperation>("outbox"),
      this.db.all<LocalSale>("sales"),
      this.db.all<HeldBill>("held"),
      this.db.get<LocalShift>("meta", "shift"),
      this.db.get<PosSettings>("meta", "settings"),
      this.db.all<PosCustomer>("customers"),
      this.db.get<string>("meta", "lastSyncAt"),
      this.db.all<LocalPurchase>("purchases")
    ]);
    sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.set({
      snapshot,
      stock: snapshot ? workingStock(snapshot, outbox, localCustomers) : null,
      outbox,
      sales: sales.slice(0, RECENT_SALES),
      held: held.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      purchases: purchases.reverse().slice(0, 100),
      shift,
      settings: settings ?? { paperWidth: 80 },
      sync: { ...this.state.sync, pending: outbox.filter((op) => op.status === "pending").length, failed: outbox.filter((op) => op.status === "failed").length, lastSyncAt, lastSnapshotAt: snapshot?.generatedAt ?? null }
    });
  }

  private async nextSequence(name: "receiptSeq" | "outboxSeq"): Promise<number> {
    return ((await this.db.get<number>("meta", name)) ?? 0) + 1;
  }

  /** Saves documents and queues operations in one atomic write, then refreshes and nudges the uploader. */
  private async commit(entries: Entry[], operations: Array<Omit<QueuedOperation, "key" | "status" | "attempts">>) {
    let sequence = await this.nextSequence("outboxSeq");
    const queued = operations.map((op) => ({ ...op, key: String(sequence++).padStart(10, "0"), status: "pending" as const, attempts: 0 }));
    await this.db.write([
      ...entries,
      ...queued.map((op) => ({ collection: "outbox" as const, id: op.key, value: op })),
      ...(queued.length ? [{ collection: "meta" as const, id: "outboxSeq", value: sequence - 1 }] : [])
    ]);
    await this.reload();
    void this.syncNow();
  }

  private operation<T extends PosOperation["type"]>(type: T, user: { id: string }, payload: Extract<PosOperation, { type: T }>["payload"]): PosOperation {
    return { id: newId(), type, userId: user.id, occurredAt: nowIso(), payload } as PosOperation;
  }

  staffMember(userId: string): PosStaffMember | undefined {
    return this.state.snapshot?.staff.find((member) => member.id === userId);
  }

  // ----- billing -----

  /** Prices a cart against this counter's stock. */
  quote(items: CartItem[], billDiscount: number) {
    const stock = this.requireStock();
    const cart = priceCart(items, stock.products, stock.batches, new Date());
    const totals = billTotals(cart, billDiscount);
    return { cart, totals };
  }

  async completeSale(input: { user: PosStaffMember; items: CartItem[]; billDiscount: number; paymentMethod: PaymentMethod; customerId?: string; cashReceived?: number }): Promise<LocalSale> {
    const shift = this.state.shift;
    if (!shift) throw new PosError("Open a shift before taking payment");
    if (!input.items.length) throw new PosError("The bill is empty");
    const { cart, totals } = this.quote(input.items, input.billDiscount);
    if (cart.problems.length) throw new PosError(cart.problems[0].message, cart.problems);
    if ("error" in totals) throw new PosError(totals.error);
    if (!discountWithinLimit(totals.subtotal, totals.discount, input.user.maxDiscountPercent)) {
      throw new PosError(`Your discount limit is ${input.user.maxDiscountPercent}% of the bill. Ask the owner to sign in for a bigger discount`);
    }

    const customer = input.customerId ? this.requireStock().customers.find((candidate) => candidate.id === input.customerId) : undefined;
    if (input.customerId && !customer) throw new PosError("Customer not found");
    if (input.paymentMethod === "credit") {
      if (!customer) throw new PosError("Choose a customer (F3) for a credit (udhaar) sale");
      if (customer.creditLimit > 0 && customer.balance + totals.total > customer.creditLimit + 0.005) {
        throw new PosError(`${customer.name} would owe PKR ${(customer.balance + totals.total).toFixed(2)}, over their limit of PKR ${customer.creditLimit.toFixed(2)}`);
      }
    }
    if (input.paymentMethod === "cash" && input.cashReceived !== undefined && input.cashReceived + 0.005 < totals.total) throw new PosError("Cash received is less than the total");

    const receiptSeq = await this.nextSequence("receiptSeq");
    const names = new Map(this.requireStock().catalogue.map((product) => [product.id, product.name]));
    const sale: LocalSale = {
      id: newId(),
      receiptNo: formatReceiptNo(this.deviceId, receiptSeq),
      createdAt: nowIso(),
      userId: input.user.id,
      userName: input.user.name,
      shiftId: shift.id,
      customerId: customer?.id,
      customerName: customer?.name,
      paymentMethod: input.paymentMethod,
      lines: cart.lines.map((line) => ({ lineId: newId(), productId: line.productId, name: names.get(line.productId) ?? "", batchId: line.batchId, batchNo: line.batchNo, unit: line.unit, quantity: line.quantity, unitPrice: line.unitPrice, discount: line.discount, lineTotal: line.lineTotal, baseUnits: line.baseUnits })),
      subtotal: totals.subtotal,
      itemDiscount: totals.itemDiscount,
      billDiscount: totals.billDiscount,
      discount: totals.discount,
      total: totals.total,
      cashReceived: input.paymentMethod === "cash" ? input.cashReceived ?? totals.total : undefined,
      change: input.paymentMethod === "cash" ? roundMoney((input.cashReceived ?? totals.total) - totals.total) : undefined,
      status: "completed",
      returns: []
    };
    const operation = { ...this.operation("sale", input.user, {
      saleId: sale.id, receiptNo: sale.receiptNo, shiftId: shift.id, customerId: sale.customerId, paymentMethod: sale.paymentMethod, billDiscount: sale.billDiscount, total: sale.total,
      lines: sale.lines.map((line) => ({ lineId: line.lineId, productId: line.productId, batchId: line.batchId, unit: line.unit, quantity: line.quantity, unitPrice: line.unitPrice, discount: line.discount }))
    }), occurredAt: sale.createdAt };

    const ops: Array<Omit<QueuedOperation, "key" | "status" | "attempts">> = [{
      operation,
      stockEffects: sale.lines.map((line) => ({ batchId: line.batchId, delta: -line.baseUnits })),
      balanceEffects: input.paymentMethod === "credit" && customer ? [{ customerId: customer.id, delta: sale.total }] : []
    }];
    if (totals.discount > 0) {
      ops.push({ operation: this.operation("audit", input.user, { action: "discount_given", entityType: "sale", entityId: sale.id, metadata: { receiptNo: sale.receiptNo, discount: totals.discount, subtotal: totals.subtotal } }), stockEffects: [], balanceEffects: [] });
    }
    await this.commit([{ collection: "sales", id: sale.id, value: sale }, { collection: "meta", id: "receiptSeq", value: receiptSeq }], ops);
    return sale;
  }

  /** Cancels a sale from the current shift: all stock goes back and any credit is reversed. */
  async voidSale(user: PosStaffMember, saleId: string, reason: string): Promise<LocalSale> {
    const sale = this.requireSale(saleId);
    if (!reason.trim()) throw new PosError("A reason is required to void a sale");
    if (sale.status !== "completed" || sale.returns.length) throw new PosError("Only a completed sale with no returns can be voided");
    if (sale.shiftId !== this.state.shift?.id) throw new PosError("Sales from an earlier shift cannot be voided; use a return instead");
    const voided: LocalSale = { ...sale, status: "voided", voidReason: reason.trim(), voidedAt: nowIso() };
    await this.commit([{ collection: "sales", id: sale.id, value: voided }], [{
      operation: this.operation("sale.void", user, { saleId: sale.id, reason: reason.trim() }),
      stockEffects: sale.lines.map((line) => ({ batchId: line.batchId, delta: line.baseUnits })),
      balanceEffects: sale.paymentMethod === "credit" && sale.customerId ? [{ customerId: sale.customerId, delta: -sale.total }] : []
    }]);
    return voided;
  }

  /** Takes items back. Stock returns to the batch it was sold from; the refund is each unit's share after discounts. */
  async returnItems(user: PosStaffMember, saleId: string, lines: Array<{ saleLineId: string; quantity: number }>, reason: string, method: PaymentMethod): Promise<{ sale: LocalSale; saleReturn: LocalReturn }> {
    const sale = this.requireSale(saleId);
    if (!reason.trim()) throw new PosError("A reason is required for a return");
    if (sale.status === "voided") throw new PosError("A voided sale cannot be returned");
    const wanted = lines.filter((line) => line.quantity > 0);
    if (!wanted.length) throw new PosError("Choose at least one item to return");
    const refund = refundFor(sale.total, sale.lines.map((line) => ({ id: line.lineId, quantity: line.quantity, lineTotal: line.lineTotal, returned: sale.returns.reduce((sum, item) => sum + (item.lines.find((entry) => entry.saleLineId === line.lineId)?.quantity ?? 0), 0) })), wanted);
    if ("error" in refund) throw new PosError(refund.error);

    const refundMethod = sale.paymentMethod === "credit" ? "credit" : method;
    const saleReturn: LocalReturn = { returnId: newId(), at: nowIso(), userId: user.id, userName: user.name, reason: reason.trim(), method: refundMethod, amount: refund.amount, lines: refund.lines };
    const allBack = sale.lines.every((line) => [...sale.returns, saleReturn].reduce((sum, item) => sum + (item.lines.find((entry) => entry.saleLineId === line.lineId)?.quantity ?? 0), 0) >= line.quantity);
    const updated: LocalSale = { ...sale, returns: [...sale.returns, saleReturn], status: allBack ? "returned" : sale.status };
    await this.commit([{ collection: "sales", id: sale.id, value: updated }], [{
      operation: this.operation("sale.return", user, { returnId: saleReturn.returnId, saleId: sale.id, reason: saleReturn.reason, refundMethod, lines: refund.lines.map(({ saleLineId, quantity }) => ({ saleLineId, quantity })) }),
      stockEffects: refund.lines.map((item) => {
        const line = sale.lines.find((candidate) => candidate.lineId === item.saleLineId)!;
        return { batchId: line.batchId, delta: line.baseUnits / line.quantity * item.quantity };
      }),
      balanceEffects: refundMethod === "credit" && sale.customerId ? [{ customerId: sale.customerId, delta: -refund.amount }] : []
    }]);
    return { sale: updated, saleReturn };
  }

// ----- stock -----

  /** Medicines on the master list that this branch does not stock yet. Needs the internet. */
  searchMaster(query: string): Promise<MasterProductSummary[]> {
    return this.transport.searchMaster(query);
  }

  /**
   * Receives a supplier invoice. New batches can be sold straight away, even offline; the server applies the
   * same invoice when it syncs. Returns warnings to show (near expiry, price differs from the master list).
   */
  async receivePurchase(user: PosStaffMember, input: ReceiveInput): Promise<LocalPurchase> {
    const stock = this.requireStock();
    const supplierName = input.supplierName.trim();
    if (!supplierName) throw new PosError("Enter the supplier");
    if (!input.lines.length) throw new PosError("Add at least one item");
    const totals = purchaseTotals(input.lines, input.invoiceDiscount);
    if ("error" in totals) throw new PosError(totals.error);

    const today = new Date();
    const warnings: string[] = [];
    const newProducts: CatalogueProduct[] = [];
    const newBatches: PosBatch[] = [];
    const stockEffects: Array<{ batchId: string; delta: number }> = [];
    const payloadLines: ReceivePurchaseLine[] = [];
    const summaryLines: LocalPurchase["lines"] = [];

    for (const [index, line] of input.lines.entries()) {
      const label = `Line ${index + 1}`;
      if (!line.batchNo.trim()) throw new PosError(`${label}: enter the batch number`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) throw new PosError(`${label}: enter the expiry date`);
      const expiry = new Date(`${line.expiryDate}T00:00:00.000Z`);
      if (Number.isNaN(expiry.getTime()) || expiry <= today) throw new PosError(`${label}: this batch has already expired and cannot be received`);

      let product = line.productId ? stock.catalogue.find((candidate) => candidate.id === line.productId) ?? newProducts.find((candidate) => candidate.id === line.productId) : undefined;
      if (!product && line.master) product = stock.catalogue.find((candidate) => candidate.masterProductId === line.master!.id) ?? newProducts.find((candidate) => candidate.masterProductId === line.master!.id);
      if (!product && line.master) {
        product = productFromMaster(newId(), line.master, this.state.snapshot!.device.branchId);
        newProducts.push(product);
      }
      if (!product) throw new PosError(`${label}: choose the item`);

      const perPack = product.unitsPerPack * product.tabletsPerStrip;
      const units = (line.quantity + line.bonusQuantity) * perPack;
      const batchNo = line.batchNo.trim();
      // The same batch may already be on the shelf, or earlier on this invoice.
      const earlierLine = newBatches.find((batch) => batch.productId === product!.id && batch.batchNo === batchNo);
      const onShelf = earlierLine ? undefined : stock.batches.find((batch) => batch.productId === product!.id && batch.batchNo === batchNo);
      const existing = earlierLine ?? onShelf;
      let batchId: string;
      if (existing) {
        batchId = existing.id;
        if (earlierLine) earlierLine.quantity += units;
        else stockEffects.push({ batchId, delta: units });
        if (existing.retailPrice !== line.retailPrice) warnings.push(`${product.name}: batch ${batchNo} is already priced PKR ${existing.retailPrice.toFixed(2)}; that price is kept`);
      } else {
        batchId = newId();
        newBatches.push({ id: batchId, productId: product.id, batchNo, expiryDate: expiry.toISOString(), quantity: units, retailPrice: line.retailPrice });
      }

      if (expiry.getTime() - today.getTime() < NEAR_EXPIRY_DAYS * 86_400_000) warnings.push(`${product.name}: batch ${batchNo} expires within ${NEAR_EXPIRY_DAYS} days`);
      if (!existing && product.officialRetailPrice != null && Math.abs(product.officialRetailPrice - line.retailPrice) > 0.005) {
        warnings.push(`${product.name}: printed price PKR ${line.retailPrice.toFixed(2)} differs from the master price PKR ${product.officialRetailPrice.toFixed(2)}; it will be reported for review`);
      }

      payloadLines.push({ productId: product.id, masterProductId: product.masterProductId ?? undefined, batchId, batchNo, expiryDate: line.expiryDate, quantity: line.quantity, bonusQuantity: line.bonusQuantity, costPrice: line.costPrice, discount: line.discount, retailPrice: line.retailPrice, serialNumber: line.serialNumber });
      summaryLines.push({ name: product.name, batchNo, expiryDate: line.expiryDate, quantity: line.quantity, bonusQuantity: line.bonusQuantity, costPrice: line.costPrice, discount: line.discount, retailPrice: line.retailPrice, effectiveCost: totals.lines[index].effectiveCost });
    }

    const knownSupplier = this.state.snapshot?.suppliers.find((supplier) => supplier.id === input.supplierId || supplier.name.toLowerCase() === supplierName.toLowerCase());
    const purchase: LocalPurchase = {
      id: newId(),
      receivedAt: nowIso(),
      userName: user.name,
      supplierName: knownSupplier?.name ?? supplierName,
      invoiceNumber: input.invoiceNumber?.trim() || undefined,
      totals: { subtotal: totals.subtotal, lineDiscount: totals.lineDiscount, invoiceDiscount: totals.invoiceDiscount, total: totals.total, paidPacks: totals.paidPacks, bonusPacks: totals.bonusPacks },
      lines: summaryLines,
      warnings
    };
    await this.commit([{ collection: "purchases", id: `${purchase.receivedAt}-${purchase.id}`, value: purchase }], [{
      operation: { ...this.operation("purchase.receive", user, {
        purchaseId: purchase.id,
        supplier: knownSupplier ? { id: knownSupplier.id, name: knownSupplier.name } : { name: supplierName },
        invoiceNumber: purchase.invoiceNumber,
        invoiceDate: input.invoiceDate || undefined,
        invoiceDiscount: totals.invoiceDiscount,
        lines: payloadLines
      }), occurredAt: purchase.receivedAt },
      stockEffects, balanceEffects: [], newBatches, newProducts
    }]);
    return purchase;
  }

  /** Write-off, damage, expiry, or correction of one batch. `quantity` is in base units; negative removes. */
  async adjustStock(user: PosStaffMember, input: { batchId: string; type: StockAdjustmentType; quantity: number; reason: string }): Promise<void> {
    if (!input.reason.trim()) throw new PosError("A reason is required");
    if (!Number.isInteger(input.quantity) || input.quantity === 0) throw new PosError("Enter how much stock changes");
    if (input.quantity > 0 && input.type !== "ADJUSTMENT") throw new PosError("Write-offs, damage, and expiry can only remove stock");
    const batch = this.requireStock().batches.find((candidate) => candidate.id === input.batchId);
    if (!batch) throw new PosError("Batch not found on this counter");
    if (batch.quantity + input.quantity < 0) throw new PosError(`Only ${batch.quantity} units of batch ${batch.batchNo} are in stock`);
    await this.commit([], [{ operation: this.operation("stock.adjust", user, { adjustmentId: newId(), batchId: batch.id, type: input.type, quantity: input.quantity, reason: input.reason.trim() }), stockEffects: [{ batchId: batch.id, delta: input.quantity }], balanceEffects: [] }]);
  }

  /** Records a physical count. Each batch moves by the difference from what the counter showed. */
  async countStock(user: PosStaffMember, lines: Array<{ batchId: string; counted: number }>, reason: string): Promise<number> {
    const batches = this.requireStock().batches;
    const counted = lines.map((line) => {
      const batch = batches.find((candidate) => candidate.id === line.batchId);
      if (!batch) throw new PosError("Batch not found on this counter");
      if (!Number.isInteger(line.counted) || line.counted < 0) throw new PosError("Counted quantities must be whole numbers");
      return { batchId: batch.id, expected: batch.quantity, counted: line.counted };
    });
    const changed = counted.filter((line) => line.counted !== line.expected);
    if (!changed.length) return 0;
    await this.commit([], [{ operation: this.operation("stock.count", user, { countId: newId(), reason: reason.trim() || "Physical count", lines: changed }), stockEffects: changed.map((line) => ({ batchId: line.batchId, delta: line.counted - line.expected })), balanceEffects: [] }]);
    return changed.length;
  }

  async updateProduct(user: PosStaffMember, productId: string, change: { rackLocation?: string | null; lowStockThreshold?: number }): Promise<void> {
    if (change.lowStockThreshold !== undefined && (!Number.isInteger(change.lowStockThreshold) || change.lowStockThreshold < 0)) throw new PosError("The alert level must be a whole number of packs");
    await this.commit([], [{ operation: this.operation("product.update", user, { productId, ...change }), stockEffects: [], balanceEffects: [], productChanges: [{ productId, ...change }] }]);
  }

  // ----- shifts -----

  async openShift(user: PosStaffMember, openingCash: number): Promise<LocalShift> {
    if (this.state.shift) throw new PosError("A shift is already open on this counter");
    if (!Number.isFinite(openingCash) || openingCash < 0) throw new PosError("Opening cash must be zero or more");
    const shift: LocalShift = { id: newId(), userId: user.id, userName: user.name, openedAt: nowIso(), openingCash: roundMoney(openingCash) };
    await this.commit([{ collection: "meta", id: "shift", value: shift }], [{ operation: { ...this.operation("shift.open", user, { shiftId: shift.id, openingCash: shift.openingCash }), occurredAt: shift.openedAt }, stockEffects: [], balanceEffects: [] }]);
    return shift;
  }

  /** End-of-day figures for the open shift, optionally against counted cash. */
  shiftReport(countedCash?: number) {
    const shift = this.state.shift;
    if (!shift) return null;
    const sales = this.state.sales.filter((sale) => sale.shiftId === shift.id);
    const refunds = this.state.sales.flatMap((sale) => sale.returns.filter((item) => item.at >= shift.openedAt).map((item) => ({ amount: item.amount, method: item.method })));
    return computeShiftReport({ openingCash: shift.openingCash, sales: sales.map((sale) => ({ total: sale.total, discount: sale.discount, paymentMethod: sale.paymentMethod, voided: sale.status === "voided" })), refunds, countedCash });
  }

  async closeShift(user: PosStaffMember, countedCash: number): Promise<LocalShift> {
    const shift = this.state.shift;
    if (!shift) throw new PosError("No shift is open");
    if (!Number.isFinite(countedCash) || countedCash < 0) throw new PosError("Counted cash must be zero or more");
    const report = this.shiftReport(roundMoney(countedCash))!;
    const closed: LocalShift = { ...shift, closedAt: nowIso(), closingCash: roundMoney(countedCash), report };
    await this.commit([{ collection: "meta", id: "shift", value: undefined }, { collection: "meta", id: `shift-${shift.id}`, value: closed }], [{
      operation: { ...this.operation("shift.close", user, { shiftId: shift.id, closingCash: closed.closingCash!, report }), occurredAt: closed.closedAt! },
      stockEffects: [], balanceEffects: []
    }]);
    return closed;
  }

  // ----- customers, held bills, audit -----

  async createCustomer(user: PosStaffMember, input: { name: string; phone?: string; creditLimit?: number }): Promise<PosCustomer> {
    if (!input.name.trim()) throw new PosError("Customer name is required");
    const phone = input.phone?.trim() || undefined;
    if (phone && this.requireStock().customers.some((customer) => customer.phone === phone)) throw new PosError("A customer with that phone number already exists");
    const customer: PosCustomer = { id: newId(), name: input.name.trim(), phone: phone ?? null, creditLimit: roundMoney(input.creditLimit ?? 0), balance: 0 };
    await this.commit([{ collection: "customers", id: customer.id, value: customer }], [{ operation: this.operation("customer.create", user, { customerId: customer.id, name: customer.name, phone, creditLimit: customer.creditLimit }), stockEffects: [], balanceEffects: [] }]);
    return customer;
  }

  async holdBill(bill: Omit<HeldBill, "id" | "createdAt">): Promise<void> {
    const id = `${Date.now()}-${newId()}`;
    await this.db.write([{ collection: "held", id, value: { ...bill, id, createdAt: nowIso() } }]);
    await this.reload();
  }

  async takeHeldBill(id: string): Promise<HeldBill | null> {
    const bill = await this.db.get<HeldBill>("held", id);
    if (bill) await this.db.write([{ collection: "held", id, value: undefined }]);
    await this.reload();
    return bill;
  }

  /** Records a counter event the owner should see, such as a deleted line or opening the cash drawer. */
  async audit(user: PosStaffMember, action: string, entityType: string, metadata?: Record<string, unknown>, entityId?: string): Promise<void> {
    await this.commit([], [{ operation: this.operation("audit", user, { action, entityType, entityId, metadata }), stockEffects: [], balanceEffects: [] }]);
  }

  async saveSettings(settings: PosSettings): Promise<void> {
    await this.db.write([{ collection: "meta", id: "settings", value: settings }]);
    await this.reload();
  }

  // ----- sync -----

  /**
   * Uploads queued operations, then refreshes the snapshot. Safe to call often: runs one at a time, and a call
   * made while a run is in progress (say, the network just came back) gets one more run afterwards.
   */
  syncNow(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.runSync();
      } while (this.syncAgain);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async runSync() {
    this.set({ sync: { ...this.state.sync, syncing: true } });
    try {
      for (;;) {
        const batch = (await this.db.all<QueuedOperation>("outbox")).filter((op) => op.status === "pending").slice(0, SYNC_BATCH);
        if (!batch.length) break;
        const results = await this.transport.push(batch.map((op) => op.operation));
        const byId = new Map(results.map((result) => [result.id, result]));
        const entries: Entry[] = [];
        for (const op of batch) {
          const result = byId.get(op.operation.id);
          if (!result) continue;
          entries.push({ collection: "outbox", id: op.key, value: result.status === "failed"
            ? { ...op, status: "failed", error: result.error, attempts: op.attempts + 1 }
            : { ...op, status: "confirmed", confirmedAt: nowIso(), attempts: op.attempts + 1 } });
        }
        await this.db.write(entries);
        // Stop if the server answered for none of them, rather than resending the same batch forever.
        if (!batch.some((op) => byId.has(op.operation.id))) break;
      }
      const requestedAt = nowIso();
      const snapshot = await this.transport.snapshot();
      await this.db.write([{ collection: "meta", id: "snapshot", value: snapshot }, { collection: "meta", id: "lastSyncAt", value: nowIso() }]);
      // The new snapshot already includes everything the server confirmed before it was requested.
      const settled = (await this.db.all<QueuedOperation>("outbox")).filter((op) => op.status === "confirmed" && op.confirmedAt! <= requestedAt);
      await this.db.write(settled.flatMap((op): Entry[] => [
        { collection: "outbox", id: op.key, value: undefined },
        // A customer added on this counter is in the snapshot from now on.
        ...(op.operation.type === "customer.create" ? [{ collection: "customers" as const, id: op.operation.payload.customerId, value: undefined }] : [])
      ]));
      this.set({ sync: { ...this.state.sync, online: true, error: null } });
    } catch (error) {
      if (error instanceof DeviceRevokedError) this.set({ deviceRevoked: true });
      this.set({ sync: { ...this.state.sync, online: !(error instanceof OfflineError), error: error instanceof OfflineError ? null : error instanceof Error ? error.message : "Sync failed" } });
    } finally {
      await this.reload();
      this.set({ sync: { ...this.state.sync, syncing: false } });
    }
  }

  /** Sends failed operations again, e.g. after the owner fixed the cause. */
  async retryFailed(): Promise<void> {
    const failed = this.state.outbox.filter((op) => op.status === "failed");
    await this.db.write(failed.map((op) => ({ collection: "outbox" as const, id: op.key, value: { ...op, status: "pending", error: undefined } })));
    await this.reload();
    await this.syncNow();
  }

  /** Background uploads every `intervalMs`, plus immediately when the network comes back. */
  start(intervalMs = 20_000): () => void {
    const kick = () => void this.syncNow();
    const offline = () => this.set({ sync: { ...this.state.sync, online: false } });
    this.timer = setInterval(kick, intervalMs);
    window.addEventListener("online", kick);
    window.addEventListener("offline", offline);
    kick();
    return () => {
      if (this.timer) clearInterval(this.timer);
      window.removeEventListener("online", kick);
      window.removeEventListener("offline", offline);
    };
  }

  private requireStock(): WorkingStock {
    if (!this.state.stock) throw new PosError("This counter has not downloaded its catalogue yet. Connect to the internet once");
    return this.state.stock;
  }

  private requireSale(saleId: string): LocalSale {
    const sale = this.state.sales.find((candidate) => candidate.id === saleId);
    if (!sale) throw new PosError("Sale not found on this counter");
    return sale;
  }
}
