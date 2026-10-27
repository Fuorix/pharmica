import type { Prisma } from "@pharmica/database/client";
import { packStructure, unitSize, type PackStructure } from "@pharmica/domain";

/**
 * Corrects how one branch product is packed. Stock is counted in base units (tablets), so each batch is rescaled to
 * keep the same number of packs: a mistyped 3 x 10 corrected to 2 x 10 turns 150 tablets (5 packs) into 100. Loose
 * tablets are rounded to the nearest whole one. Every change is a stock movement, so the ledger still adds up.
 */
export async function changePacking(
  tx: Prisma.TransactionClient,
  product: Prisma.ProductGetPayload<{ include: { masterProduct: true } }>,
  next: PackStructure,
  userId: string
): Promise<{ changed: boolean; from: PackStructure }> {
  const from = packStructure(product);
  if (from.stripsPerPack === next.stripsPerPack && from.tabletsPerStrip === next.tabletsPerStrip) return { changed: false, from };

  const oldPerPack = unitSize("pack", from);
  const newPerPack = unitSize("pack", next);
  const reason = `Packing corrected from ${from.stripsPerPack} x ${from.tabletsPerStrip} to ${next.stripsPerPack} x ${next.tabletsPerStrip}`;
  for (const batch of await tx.batch.findMany({ where: { productId: product.id, quantity: { gt: 0 } } })) {
    const quantity = Math.round(batch.quantity * newPerPack / oldPerPack);
    if (quantity === batch.quantity) continue;
    await tx.batch.update({ where: { id: batch.id }, data: { quantity } });
    await tx.stockMovement.create({ data: { branchId: product.branchId, productId: product.id, batchId: batch.id, userId, type: "ADJUSTMENT", quantity: quantity - batch.quantity, reason } });
  }
  await tx.product.update({ where: { id: product.id }, data: { unitsPerPack: next.stripsPerPack, tabletsPerStrip: next.tabletsPerStrip } });
  return { changed: true, from };
}
