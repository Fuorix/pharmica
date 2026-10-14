-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "creditLimit" DROP NOT NULL;


-- A credit limit of 0 used to mean "no limit"; it now means "no credit allowed", and no limit is NULL.
-- Customers created before this change keep the behaviour they had.
UPDATE "Customer" SET "creditLimit" = NULL WHERE "creditLimit" = 0;
