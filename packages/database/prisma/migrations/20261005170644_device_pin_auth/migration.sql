-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "secretHash" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinHash" TEXT,
ALTER COLUMN "credentialHash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AuditLog_action_entityId_createdAt_idx" ON "AuditLog"("action", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
