-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'OPENING';
ALTER TYPE "StockMovementType" ADD VALUE 'COUNT';

-- DropForeignKey
ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_userId_fkey";

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PriceChangeReport" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "purchaseId" TEXT,
ADD COLUMN     "reportedById" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "bonusPacks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "invoiceDate" TIMESTAMP(3),
ADD COLUMN     "lineDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseLine" ADD COLUMN     "effectiveCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "invoiceDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serialNumber" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Purchase_supplierId_invoiceNumber_idx" ON "Purchase"("supplierId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "StockMovement_batchId_idx" ON "StockMovement"("batchId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceChangeReport" ADD CONSTRAINT "PriceChangeReport_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceChangeReport" ADD CONSTRAINT "PriceChangeReport_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Business invariants Prisma cannot express.
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_amounts_non_negative" CHECK ("costPrice" >= 0 AND "retailPrice" >= 0 AND "tradeDiscount" >= 0 AND "invoiceDiscount" >= 0 AND "effectiveCost" >= 0);
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_amounts_non_negative" CHECK ("subtotal" >= 0 AND "lineDiscount" >= 0 AND "tradeDiscount" >= 0 AND "total" >= 0 AND "bonusPacks" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_low_stock_non_negative" CHECK ("lowStockThreshold" >= 0);
