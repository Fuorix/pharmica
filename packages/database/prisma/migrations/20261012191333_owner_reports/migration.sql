-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "address" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "settings" JSONB;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "unitCost" DECIMAL(12,4);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidFrom" TEXT NOT NULL DEFAULT 'cash',
    "note" TEXT,
    "spentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Expense_branchId_spentAt_idx" ON "Expense"("branchId", "spentAt");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Expense" ADD CONSTRAINT "Expense_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_unit_cost_non_negative" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);

-- Record the cost of what was already sold, from each line's batch: the batch cost is per pack, so it is divided
-- down to the strip or tablet that was sold.
UPDATE "SaleLine" sl
SET "unitCost" = b."costPrice" / CASE sl."unit"
    WHEN 'PACK' THEN 1
    WHEN 'STRIP' THEN COALESCE(m."unitsPerPack", p."unitsPerPack", 1)
    ELSE COALESCE(m."unitsPerPack", p."unitsPerPack", 1) * COALESCE(m."tabletsPerStrip", p."tabletsPerStrip", 1)
  END
FROM "Batch" b
JOIN "Product" p ON p."id" = b."productId"
LEFT JOIN "MasterProduct" m ON m."id" = p."masterProductId"
WHERE sl."batchId" = b."id" AND b."costPrice" IS NOT NULL;
