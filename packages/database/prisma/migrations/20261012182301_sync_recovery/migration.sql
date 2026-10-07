-- DropForeignKey
ALTER TABLE "SyncChange" DROP CONSTRAINT "SyncChange_branchId_fkey";

-- DropForeignKey
ALTER TABLE "SyncChange" DROP CONSTRAINT "SyncChange_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "SyncChange" DROP CONSTRAINT "SyncChange_operationId_fkey";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "syncCursor",
ADD COLUMN     "diagnostics" JSONB,
ADD COLUMN     "diagnosticsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SyncOperation" ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "userId" TEXT;

-- DropTable
DROP TABLE "SyncChange";

-- CreateIndex
CREATE INDEX "MasterProduct_updatedAt_id_idx" ON "MasterProduct"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "SyncOperation_branchId_status_idx" ON "SyncOperation"("branchId", "status");


-- Applied operations used to keep their review flags in "errorMessage" (comma-separated). Move them to "flags",
-- and fill in when and by whom each operation happened from its stored payload.
UPDATE "SyncOperation" SET "flags" = string_to_array("errorMessage", ','), "errorMessage" = NULL WHERE "status" = 'APPLIED' AND "errorMessage" IS NOT NULL;
UPDATE "SyncOperation" SET "occurredAt" = ("payload"->>'occurredAt')::timestamptz, "userId" = "payload"->>'userId' WHERE "payload" ? 'occurredAt';
