-- Counters are linked with a shop code plus a staff PIN instead of one-time activation codes.

-- Each pharmacy gets a permanent 6-character shop code (no 0/O or 1/I look-alikes).
ALTER TABLE "Organisation" ADD COLUMN "shopCode" TEXT;
UPDATE "Organisation" AS o SET "shopCode" = (
  SELECT string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '')
  -- Referencing the outer row makes Postgres draw a new code for every pharmacy.
  FROM generate_series(1, 6 + 0 * length(o."id"))
);
ALTER TABLE "Organisation" ALTER COLUMN "shopCode" SET NOT NULL;
CREATE UNIQUE INDEX "Organisation_shopCode_key" ON "Organisation"("shopCode");

-- Existing counters are numbered per pharmacy in the order they were created and renamed to <shopCode>-<number>.
-- Linked counters stay linked; only the one-time codes go.
ALTER TABLE "Device" ADD COLUMN "counterNumber" INTEGER;
UPDATE "Device" AS d SET "counterNumber" = numbered.n, "name" = numbered."shopCode" || '-' || numbered.n
FROM (
  SELECT d2."id", o."shopCode", ROW_NUMBER() OVER (PARTITION BY o."id" ORDER BY d2."createdAt", d2."id") AS n
  FROM "Device" d2 JOIN "Branch" b ON b."id" = d2."branchId" JOIN "Organisation" o ON o."id" = b."organisationId"
) AS numbered
WHERE numbered."id" = d."id";
ALTER TABLE "Device" ALTER COLUMN "counterNumber" SET NOT NULL;
DROP INDEX "Device_activationCode_key";
ALTER TABLE "Device" DROP COLUMN "activationCode";
CREATE UNIQUE INDEX "Device_name_key" ON "Device"("name");

-- Held bills are no longer a feature.
DROP TABLE "HeldBill";
