import type { Prisma, PrismaClient } from "../generated/client";

/**
 * A Prisma client or a transaction client.
 *
 * The boundary has to accept both, and that is not a convenience.
 *
 * The NIL-487 inventory listed 18 raw grant reads, all on `prisma.`. Measuring
 * again found five more on `tx.` -- and auth/userOffboarding.ts touches the
 * grant tables *only* through a transaction. If the contract could not be
 * called from inside a transaction, that file would have needed an exception
 * on day one, and an exception list that starts with a permanent entry is a
 * wildcard with extra steps.
 */
export type AuthzDb = PrismaClient | Prisma.TransactionClient;
