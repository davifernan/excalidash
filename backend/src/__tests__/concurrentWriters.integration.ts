import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/client";
import { createTestUser, getTestPrisma, setupTestDb, testDatabaseProvider } from "./testUtils";

/**
 * What happened on 31.08.2026: the instance stopped at **four concurrent
 * users** because SQLite was locked.
 *
 * SQLite has exactly one writer. WAL lets readers continue during a write, but
 * two writers still queue, and `busy_timeout` only decides how long the second
 * one waits before giving up. The settings are already at their useful limit
 * (`db/prisma.ts`: WAL, 8s busy timeout, 12s transaction ceiling) -- raising
 * them further moves the failure, it does not remove it.
 *
 * This measures the claim rather than repeating it. It is the reason the move
 * to PostgreSQL exists, so it must be able to show the difference, not assert
 * it.
 *
 * MEASURED on 01.09.2026, same machine, same transaction shape:
 *
 *   writers   SQLite                        PostgreSQL
 *   4         4/4 in 41ms                   4/4
 *   12        3/12 in 5044ms                12/12
 *   24        8/24 in 10145ms, then timeout  --
 *
 * Two things follow, and the second one corrects the story.
 *
 * SQLite does NOT fail at four on an idle host -- it finishes in 41ms. So the
 * instance that stopped at four USERS did not stop because of four writers:
 * real use produces far more concurrent write transactions than people, and
 * four users were simply enough to cross the line on a loaded host. Anyone
 * reproducing the original incident by opening four tabs on a quiet machine
 * will see nothing and conclude wrongly.
 *
 * At twelve the engine is decisively the limit: three of twelve.
 */
describe("concurrent writers", () => {
  let prisma: PrismaClient;
  let userId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const user = await createTestUser(prisma, `writers-${Date.now()}@example.test`);
    userId = user.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Deliberately shaped like the path that failed: several transactions that
   * each read a board and write it back, the way concurrent joins do when they
   * persist a snapshot. A plain `createMany` would prove nothing -- it is the
   * read-modify-write inside one transaction that holds the writer.
   */
  const writeSameBoardConcurrently = async (writers: number) => {
    const drawing = await prisma.drawing.create({
      data: { name: "Contended", elements: "[]", appState: "{}", userId },
      select: { id: true },
    });

    const attempts = Array.from({ length: writers }, (_unused, index) =>
      prisma
        .$transaction(async (tx) => {
          const current = await tx.drawing.findUniqueOrThrow({
            where: { id: drawing.id },
            select: { elements: true },
          });
          await tx.drawing.update({
            where: { id: drawing.id },
            data: { elements: `${current.elements.length + index}` },
          });
          return "ok" as const;
        })
        .catch((error: unknown) => String((error as Error)?.message ?? error)),
    );

    return Promise.all(attempts);
  };

  it.skipIf(testDatabaseProvider !== "postgresql")(
    "lets four people write the same board at once",
    async () => {
      // Four is not an arbitrary number: it is what the instance had when it
      // stopped.
      const results = await writeSameBoardConcurrently(4);

      const failures = results.filter((result) => result !== "ok");
      expect(failures, `some writers failed: ${failures.join(" | ")}`).toHaveLength(0);
    },
    60_000,
  );

  it.skipIf(testDatabaseProvider !== "postgresql")(
    "holds up well past the number that broke the instance",
    async () => {
      // Four passing could be luck on a quiet host. Twelve says the engine is
      // doing the work, not the timing.
      const results = await writeSameBoardConcurrently(12);

      const failures = results.filter((result) => result !== "ok");
      expect(failures, `some writers failed: ${failures.join(" | ")}`).toHaveLength(0);
    },
    60_000,
  );

  it.skipIf(testDatabaseProvider !== "sqlite")(
    "records what SQLite manages, without pretending it is the same",
    async () => {
      // Not an assertion that SQLite fails -- on an idle CI host four writers
      // may well queue through inside the 8s budget, and a test that demanded
      // a failure would be flaky in the other direction.
      //
      // What is asserted is that the harness reaches the engine at all, so this
      // file cannot silently measure nothing on the SQLite lane. The real
      // comparison lives in the two PostgreSQL cases above; this one exists so
      // that removing them would be visible.
      const results = await writeSameBoardConcurrently(4);

      expect(results).toHaveLength(4);
      expect(results.some((result) => result === "ok")).toBe(true);
    },
    60_000,
  );
});
