-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'JAZZCASH', 'EASYPAISA', 'RAAST');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "PriceListStatus" AS ENUM ('REVIEW', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PriceListMatch" AS ENUM ('MATCHED', 'UNCHANGED', 'NOT_FOUND', 'AMBIGUOUS', 'INVALID');

-- AlterTable
ALTER TABLE "MasterProduct" ADD COLUMN     "mergedIntoId" TEXT;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "city" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onboarding" JSONB,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "PriceChangeReport" ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangeCredential" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DECIMAL(12,2) NOT NULL,
    "quarterlyDiscountPercent" INTEGER NOT NULL DEFAULT 0,
    "yearlyDiscountPercent" INTEGER NOT NULL DEFAULT 0,
    "maxBranches" INTEGER,
    "maxDevices" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "isTrial" BOOLEAN NOT NULL DEFAULT true,
    "paidThrough" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus",
    "actorId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "months" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "invoiceId" TEXT,
    "method" "SubscriptionPaymentMethod" NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "providerTransactionId" TEXT,
    "note" TEXT,
    "raw" JSONB,
    "recordedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListUpload" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fileName" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "status" "PriceListStatus" NOT NULL DEFAULT 'REVIEW',
    "uploadedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceListUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListRow" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "barcode" TEXT,
    "registrationNo" TEXT,
    "price" DECIMAL(12,2),
    "masterProductId" TEXT,
    "currentPrice" DECIMAL(12,2),
    "match" "PriceListMatch" NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "problem" TEXT,

    CONSTRAINT "PriceListRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterProductMerge" (
    "id" TEXT NOT NULL,
    "keptId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "mergedName" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "reason" TEXT,
    "branchProductsRelinked" INTEGER NOT NULL DEFAULT 0,
    "branchProductsUnlinked" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasterProductMerge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organisationId_key" ON "Subscription"("organisationId");

-- CreateIndex
CREATE INDEX "Subscription_status_paidThrough_idx" ON "Subscription"("status", "paidThrough");

-- CreateIndex
CREATE INDEX "SubscriptionEvent_subscriptionId_createdAt_idx" ON "SubscriptionEvent"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_number_key" ON "SubscriptionInvoice"("number");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_organisationId_issuedAt_idx" ON "SubscriptionInvoice"("organisationId", "issuedAt");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_status_dueAt_idx" ON "SubscriptionInvoice"("status", "dueAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_organisationId_receivedAt_idx" ON "SubscriptionPayment"("organisationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_method_providerTransactionId_key" ON "SubscriptionPayment"("method", "providerTransactionId");

-- CreateIndex
CREATE INDEX "PriceListUpload_status_createdAt_idx" ON "PriceListUpload"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PriceListRow_uploadId_line_idx" ON "PriceListRow"("uploadId", "line");

-- CreateIndex
CREATE INDEX "MasterProductMerge_keptId_idx" ON "MasterProductMerge"("keptId");

-- AddForeignKey
ALTER TABLE "MasterProduct" ADD CONSTRAINT "MasterProduct_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "MasterProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubscriptionInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListRow" ADD CONSTRAINT "PriceListRow_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "PriceListUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Money and limits are never negative; discounts are percentages.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_price_non_negative" CHECK ("monthlyPrice" >= 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_discounts_are_percentages" CHECK ("quarterlyDiscountPercent" BETWEEN 0 AND 100 AND "yearlyDiscountPercent" BETWEEN 0 AND 100);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_limits_positive" CHECK (("maxBranches" IS NULL OR "maxBranches" > 0) AND ("maxDevices" IS NULL OR "maxDevices" > 0) AND "trialDays" >= 0);
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_amounts_valid" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "total" = "subtotal" - "discount" AND "months" > 0 AND "periodEnd" > "periodStart");
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "MasterProduct" ADD CONSTRAINT "MasterProduct_not_merged_into_itself" CHECK ("mergedIntoId" IS NULL OR "mergedIntoId" <> "id");

-- Subscription history is append-only, so every transition stays auditable. Test cleanup may set
-- pharmica.allow_register_purge for its own transaction, as for the narcotics register.
CREATE FUNCTION subscription_events_are_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pharmica.allow_register_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Subscription history cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscription_events_append_only
BEFORE UPDATE OR DELETE ON "SubscriptionEvent"
FOR EACH ROW EXECUTE FUNCTION subscription_events_are_append_only();

-- Starting plans. Pharmica staff can change prices and limits from the admin panel.
INSERT INTO "Plan" ("id", "code", "name", "monthlyPrice", "quarterlyDiscountPercent", "yearlyDiscountPercent", "maxBranches", "maxDevices", "features", "trialDays", "updatedAt") VALUES
  ('plan_starter', 'starter', 'Starter', 3000, 5, 15, 1, 2, ARRAY['reports'], 14, CURRENT_TIMESTAMP),
  ('plan_pro', 'pro', 'Pro', 6000, 5, 15, 3, 6, ARRAY['reports', 'accounting', 'mobile'], 14, CURRENT_TIMESTAMP),
  ('plan_chain', 'chain', 'Chain', 12000, 5, 15, NULL, NULL, ARRAY['reports', 'accounting', 'mobile'], 14, CURRENT_TIMESTAMP);

-- Pharmacies that existed before subscriptions start on a 30-day Pro trial.
INSERT INTO "Subscription" ("id", "organisationId", "planId", "period", "status", "isTrial", "paidThrough", "updatedAt")
SELECT 'sub_' || "id", "id", 'plan_pro', 'MONTHLY', 'TRIAL', true, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP FROM "Organisation";

INSERT INTO "SubscriptionEvent" ("id", "subscriptionId", "type", "toStatus", "reason")
SELECT 'subev_' || "id", "id", 'created', 'TRIAL', 'Existing pharmacy moved onto subscriptions' FROM "Subscription";
