import type { PaymentMethod } from "@pharmica/contracts";
import { roundMoney } from "./units";

export interface ShiftSaleRecord {
  total: number;
  discount: number;
  paymentMethod: PaymentMethod;
  voided: boolean;
}

export interface ShiftRefundRecord {
  amount: number;
  method: PaymentMethod;
}

export interface ShiftReport {
  openingCash: number;
  salesCount: number;
  voidCount: number;
  returnCount: number;
  /** Totals of completed (not voided) sales after discounts. */
  netSales: number;
  discounts: number;
  byMethod: Record<PaymentMethod, number>;
  refunds: Record<PaymentMethod, number>;
  /** Credit (udhaar) repayments received during the shift, by method. */
  collections: Record<PaymentMethod, number>;
  /** Opening cash + cash sales + cash repayments - cash refunds. */
  expectedCash: number;
  countedCash: number | null;
  /** Counted minus expected; negative means cash is short. */
  variance: number | null;
}

const emptyByMethod = (): Record<PaymentMethod, number> => ({ cash: 0, card: 0, credit: 0 });

/** End-of-day closing figures for one shift. */
export function computeShiftReport(input: { openingCash: number; sales: ShiftSaleRecord[]; refunds: ShiftRefundRecord[]; collections?: ShiftRefundRecord[]; countedCash?: number | null }): ShiftReport {
  const completed = input.sales.filter((sale) => !sale.voided);
  const byMethod = emptyByMethod();
  for (const sale of completed) byMethod[sale.paymentMethod] = roundMoney(byMethod[sale.paymentMethod] + sale.total);
  const refunds = emptyByMethod();
  for (const refund of input.refunds) refunds[refund.method] = roundMoney(refunds[refund.method] + refund.amount);

  const collections = emptyByMethod();
  for (const payment of input.collections ?? []) collections[payment.method] = roundMoney(collections[payment.method] + payment.amount);

  const expectedCash = roundMoney(input.openingCash + byMethod.cash + collections.cash - refunds.cash);
  const countedCash = input.countedCash ?? null;
  return {
    openingCash: input.openingCash,
    salesCount: completed.length,
    voidCount: input.sales.length - completed.length,
    returnCount: input.refunds.length,
    netSales: roundMoney(completed.reduce((sum, sale) => sum + sale.total, 0)),
    discounts: roundMoney(completed.reduce((sum, sale) => sum + sale.discount, 0)),
    byMethod,
    refunds,
    collections,
    expectedCash,
    countedCash,
    variance: countedCash == null ? null : roundMoney(countedCash - expectedCash)
  };
}
