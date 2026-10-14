-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('STOCK', 'CUSTOMERS', 'SUPPLIERS');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('MAPPING', 'REVIEW', 'COMMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('READY', 'NEEDS_REVIEW', 'INVALID', 'SKIPPED', 'COMMITTED');

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'MAPPING',
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "headers" TEXT[],
    "columnMap" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "committedById" TEXT,
    "committedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "data" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'READY',
    "problems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action" TEXT,
    "masterProductId" TEXT,
    "productId" TEXT,
    "score" DOUBLE PRECISION,
    "candidates" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_branchId_kind_fileHash_idx" ON "ImportJob"("branchId", "kind", "fileHash");

-- CreateIndex
CREATE INDEX "ImportJob_organisationId_createdAt_idx" ON "ImportJob"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_jobId_line_idx" ON "ImportRow"("jobId", "line");

-- CreateIndex
CREATE INDEX "ImportRow_jobId_status_idx" ON "ImportRow"("jobId", "status");

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_row_count_non_negative" CHECK ("rowCount" >= 0);
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_line_positive" CHECK ("line" > 1);
