import { randomBytes } from "node:crypto";
import { db, type Prisma } from "@pharmica/database/client";

/** Letters and digits that cannot be mistaken for each other when read out or typed: no 0/O or 1/I. */
const SHOP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SHOP_CODE_LENGTH = 6;

export function newShopCode(): string {
  // 256 is a multiple of the 32-letter alphabet, so every character is equally likely.
  return [...randomBytes(SHOP_CODE_LENGTH)].map((byte) => SHOP_CODE_ALPHABET[byte % SHOP_CODE_ALPHABET.length]).join("");
}

/** A shop code no pharmacy has yet. With about a billion codes a clash is rare, so a few tries are plenty. */
export async function uniqueShopCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newShopCode();
    if (!await db.organisation.findUnique({ where: { shopCode: code }, select: { id: true } })) return code;
  }
  throw new Error("Could not find a free shop code");
}

/** The counter's name, which is also what is typed on a new computer to link it: `K7P2QX-1`. */
export function counterName(shopCode: string, counterNumber: number): string {
  return `${shopCode}-${counterNumber}`;
}

/** Reads what someone typed as a counter name ("k7p2qx - 01" → "K7P2QX-1"), or null if it is not one. */
export function parseCounterName(input: string): string | null {
  const match = input.trim().toUpperCase().match(/^([A-Z0-9]{6})\s*-\s*0*(\d{1,4})$/);
  if (!match || Number(match[2]) < 1) return null;
  return counterName(match[1], Number(match[2]));
}

/** The lowest counter number this pharmacy has not used yet. */
export async function nextCounterNumber(tx: Prisma.TransactionClient, organisationId: string): Promise<number> {
  const used = new Set((await tx.device.findMany({ where: { branch: { organisationId } }, select: { counterNumber: true } })).map((device) => device.counterNumber));
  let number = 1;
  while (used.has(number)) number++;
  return number;
}
