-- AlterEnum
ALTER TYPE "CustomerLedgerType" ADD VALUE 'CREDIT_RETURN';

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "receiptNo" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "discount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "closingReport" JSONB,
ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "maxDiscountPercent" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SaleReturn" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "reason" TEXT NOT NULL,
    "refundMethod" "PaymentMethod" NOT NULL,
    "refundAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "SaleReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaleReturn_branchId_createdAt_idx" ON "SaleReturn"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleReturn_saleId_idx" ON "SaleReturn"("saleId");

-- CreateIndex
CREATE INDEX "SaleReturnLine_saleLineId_idx" ON "SaleReturnLine"("saleLineId");

-- CreateIndex
CREATE INDEX "Sale_shiftId_idx" ON "Sale"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_branchId_receiptNo_key" ON "Sale"("branchId", "receiptNo");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnLine" ADD CONSTRAINT "SaleReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "SaleReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnLine" ADD CONSTRAINT "SaleReturnLine_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business invariants Prisma cannot express.
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_discount_valid" CHECK ("discount" >= 0 AND "discount" <= "unitPrice" * "quantity");
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_refund_non_negative" CHECK ("refundAmount" >= 0);
ALTER TABLE "SaleReturnLine" ADD CONSTRAINT "SaleReturnLine_quantity_positive" CHECK ("quantity" > 0 AND "amount" >= 0);
ALTER TABLE "User" ADD CONSTRAINT "User_max_discount_range" CHECK ("maxDiscountPercent" BETWEEN 0 AND 100);
