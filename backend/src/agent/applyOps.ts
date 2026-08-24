/**
 * Applies a validated batch of ops (opSchemas.ts) to a scene's current
 * elements, all-or-nothing. A pure function deliberately: it does not touch
 * Prisma or the request -- routes/dashboard/drawingAgentRoutes.ts computes
 * the result here first and only opens a transaction once the whole batch is
 * known to succeed, so "the whole batch is discarded on any error" falls out
 * of when the DB write happens, not out of a rollback.
 *
 * Known limitation, by design: an op can only reference an element id that
 * existed before this batch started. `create` always assigns a fresh
 * server-side id (see below), which the caller cannot know in advance, so a
 * single batch cannot create an element and then update or delete that same
 * element -- two batches are required. This keeps id assignment entirely
 * server-side without adding a client-side temp-id resolution mechanism.
 */
import { randomUUID } from "node:crypto";
import type { Op } from "./opSchemas";

/**
 * Not a discriminated union on `ok` -- `elements`/`error` are both optional
 * instead. A real discriminated union here made `tsc` pathologically slow
 * (multi-minute, in one run non-terminating within the sandbox's timeout) at
 * every call site that narrowed on `.ok`, because the `ok: true` arm's
 * `elements` carries the same deeply-passthrough element shape ops build up
 * from Zod-inferred, `.passthrough()` types (opSchemas.ts) -- checking that
 * arm's assignability is what got expensive. A caller checks `result.ok`
 * and reads `result.error` (guaranteed set when `!result.ok`) or
 * `result.elements!` (guaranteed set when `result.ok`) without the compiler
 * having to prove it structurally.
 */
export type ApplyOpsResult = {
  ok: boolean;
  elements?: Record<string, unknown>[];
  error?: string;
};

const nextVersionNonce = (): number => Math.floor(Math.random() * 2 ** 31);

const isElementRecord = (value: unknown): value is Record<string, unknown> & { id: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).id === "string";

export const applyOperations = (currentElements: unknown[], ops: readonly Op[]): ApplyOpsResult => {
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const element of currentElements) {
    if (!isElementRecord(element)) continue;
    byId.set(element.id, element);
    order.push(element.id);
  }

  const now = Date.now();
  const created: string[] = [];

  for (const op of ops) {
    if (op.op === "create") {
      const id = randomUUID();
      byId.set(id, {
        ...op.element,
        id,
        version: 1,
        versionNonce: nextVersionNonce(),
        updated: now,
        isDeleted: false,
      });
      created.push(id);
      continue;
    }

    const existing = byId.get(op.id);
    if (!existing || existing.isDeleted === true) {
      return {
        ok: false,
        error: `Operation "${op.op}" references unknown element id "${op.id}"`,
      };
    }

    if (op.op === "update") {
      byId.set(op.id, {
        ...existing,
        ...op.patch,
        id: existing.id,
        version: (typeof existing.version === "number" ? existing.version : 0) + 1,
        versionNonce: nextVersionNonce(),
        updated: now,
      });
    } else {
      byId.set(op.id, {
        ...existing,
        isDeleted: true,
        version: (typeof existing.version === "number" ? existing.version : 0) + 1,
        versionNonce: nextVersionNonce(),
        updated: now,
      });
    }
  }

  const finalOrder = [...order, ...created];
  return { ok: true, elements: finalOrder.map((id) => byId.get(id)!) };
};
