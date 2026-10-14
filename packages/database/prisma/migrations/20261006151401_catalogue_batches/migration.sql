-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('MEDICINE', 'COSMETIC', 'SURGICAL', 'BABY', 'GENERAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'SALE';
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_RETURN';

-- AlterTable
ALTER TABLE "MasterPriceHistory" ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "reference" TEXT;

-- AlterTable
ALTER TABLE "MasterProduct" ADD COLUMN     "dosageForm" TEXT,
ADD COLUMN     "drapRegistrationNo" TEXT,
ADD COLUMN     "strength" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "category" "ProductCategory" NOT NULL DEFAULT 'MEDICINE',
ADD COLUMN     "company" TEXT,
ADD COLUMN     "tabletsPerStrip" INTEGER,
ADD COLUMN     "unitsPerPack" INTEGER;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MasterProduct_drapRegistrationNo_key" ON "MasterProduct"("drapRegistrationNo");

-- CreateIndex
CREATE UNIQUE INDEX "Product_branchId_masterProductId_key" ON "Product"("branchId", "masterProductId");

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Business invariants Prisma cannot express: stock and money never go negative.
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_prices_non_negative" CHECK ("retailPrice" >= 0 AND ("costPrice" IS NULL OR "costPrice" >= 0));
ALTER TABLE "MasterProduct" ADD CONSTRAINT "MasterProduct_pack_structure_positive" CHECK ("unitsPerPack" >= 1 AND "tabletsPerStrip" >= 1);
ALTER TABLE "MasterProduct" ADD CONSTRAINT "MasterProduct_price_non_negative" CHECK ("officialRetailPrice" IS NULL OR "officialRetailPrice" >= 0);
ALTER TABLE "MasterPriceHistory" ADD CONSTRAINT "MasterPriceHistory_price_non_negative" CHECK ("price" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_pack_structure_positive" CHECK (("unitsPerPack" IS NULL OR "unitsPerPack" >= 1) AND ("tabletsPerStrip" IS NULL OR "tabletsPerStrip" >= 1));
ALTER TABLE "Product" ADD CONSTRAINT "Product_override_non_negative" CHECK ("retailPriceOverride" IS NULL OR "retailPriceOverride" >= 0);
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_quantity_positive" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_amounts_non_negative" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "total" >= 0);
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_quantities_valid" CHECK ("quantity" > 0 AND "bonusQuantity" >= 0);
