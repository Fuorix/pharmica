import { PrismaClient } from "@prisma/client";

export { PrismaClient } from "@prisma/client";
export type { Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { pharmicaDb?: PrismaClient };

export const db = globalForPrisma.pharmicaDb ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.pharmicaDb = db;
}
