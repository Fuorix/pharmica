-- CreateEnum
CREATE TYPE "ControlledEntryType" AS ENUM ('ENTRY', 'REVERSAL');

-- AlterTable
ALTER TABLE "ControlledDrugRecord" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "doctorRegNo" TEXT,
ADD COLUMN     "entryType" "ControlledEntryType" NOT NULL DEFAULT 'ENTRY',
ADD COLUMN     "patientPhone" TEXT,
ADD COLUMN     "prescriptionRef" TEXT,
ADD COLUMN     "reversesId" TEXT,
ADD COLUMN     "saleLineId" TEXT,
ADD COLUMN     "unit" "SaleUnit" NOT NULL DEFAULT 'PACK';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CustomerLedgerEntry" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "address" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "SupplierLedgerEntry" ADD COLUMN     "method" TEXT,
ADD COLUMN     "reference" TEXT;

-- CreateIndex
CREATE INDEX "ControlledDrugRecord_saleId_idx" ON "ControlledDrugRecord"("saleId");


-- Ledger amounts are positive, except adjustments, which carry a sign and are never zero.
ALTER TABLE "CustomerLedgerEntry" ADD CONSTRAINT "CustomerLedgerEntry_amount_valid" CHECK (("type" = 'ADJUSTMENT' AND "amount" <> 0) OR ("type" <> 'ADJUSTMENT' AND "amount" > 0));
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_amount_valid" CHECK (("type" = 'ADJUSTMENT' AND "amount" <> 0) OR ("type" <> 'ADJUSTMENT' AND "amount" > 0));

-- The narcotics register is append-only: entries can never be edited or deleted. Mistakes are corrected with
-- REVERSAL entries. Only test cleanup tooling may delete, and only after explicitly setting
-- pharmica.allow_register_purge for its own transaction.
CREATE FUNCTION controlled_register_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('pharmica.allow_register_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'The narcotics register cannot be changed or deleted; record a reversal instead'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER controlled_register_append_only
BEFORE UPDATE OR DELETE ON "ControlledDrugRecord"
FOR EACH ROW EXECUTE FUNCTION controlled_register_is_append_only();
