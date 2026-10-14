-- Every batch's quantity must equal the sum of its stock movements. Batches created before the ledger
-- existed (seed data, early purchases) get one OPENING movement for whatever their movements don't explain.
INSERT INTO "StockMovement" ("id", "branchId", "productId", "batchId", "userId", "type", "quantity", "reason", "createdAt")
SELECT gen_random_uuid()::text, p."branchId", b."productId", b."id", NULL, 'OPENING', b."quantity" - COALESCE(m."total", 0), 'Opening balance recorded when the stock ledger started', CURRENT_TIMESTAMP
FROM "Batch" b
JOIN "Product" p ON p."id" = b."productId"
LEFT JOIN (SELECT "batchId", SUM("quantity") AS "total" FROM "StockMovement" WHERE "batchId" IS NOT NULL GROUP BY "batchId") m ON m."batchId" = b."id"
WHERE b."quantity" - COALESCE(m."total", 0) <> 0;

-- Before this release a purchase line's "tradeDiscount" held a copy of the invoice discount, and lines had no
-- effective cost. Old lines get no line discount and an effective cost equal to their invoice price.
UPDATE "PurchaseLine" SET "tradeDiscount" = 0, "effectiveCost" = "costPrice" WHERE "effectiveCost" = 0;
