import { randomUUID } from "node:crypto";

export type DocumentEditLock = Readonly<{
  drawingId: string;
  assetId: string;
  presenceId: string;
  ownerName: string;
  token: string;
}>;

export type PublicDocumentEditLock = Omit<DocumentEditLock, "token" | "drawingId">;

const keyOf = (drawingId: string, assetId: string) => `${drawingId}\u0000${assetId}`;

/**
 * Process-local, connection-owned Stage-1 edit locks.
 *
 * A lock is intentionally not durable state: a process restart or socket
 * disconnect means nobody is still editing through that connection. The
 * content write additionally carries this lock's unguessable token and the
 * source blob revision, so the UI hint is backed by enforcement rather than
 * being a polite convention between browsers.
 */
export class DocumentEditLockRegistry {
  private readonly locks = new Map<string, DocumentEditLock>();

  acquire(
    input: Omit<DocumentEditLock, "token">,
  ): { ok: true; lock: DocumentEditLock } | { ok: false; lock: DocumentEditLock } {
    const key = keyOf(input.drawingId, input.assetId);
    const existing = this.locks.get(key);
    if (existing) {
      return existing.presenceId === input.presenceId
        ? { ok: true, lock: existing }
        : { ok: false, lock: existing };
    }

    const lock: DocumentEditLock = { ...input, token: randomUUID() };
    this.locks.set(key, lock);
    return { ok: true, lock };
  }

  get(drawingId: string, assetId: string): DocumentEditLock | null {
    return this.locks.get(keyOf(drawingId, assetId)) ?? null;
  }

  validate(drawingId: string, assetId: string, token: string): DocumentEditLock | null {
    const lock = this.get(drawingId, assetId);
    return lock?.token === token ? lock : null;
  }

  release(drawingId: string, assetId: string, presenceId: string, token?: string): boolean {
    const key = keyOf(drawingId, assetId);
    const lock = this.locks.get(key);
    if (!lock || lock.presenceId !== presenceId || (token && lock.token !== token)) return false;
    this.locks.delete(key);
    return true;
  }

  releaseToken(drawingId: string, assetId: string, token: string): DocumentEditLock | null {
    const lock = this.validate(drawingId, assetId, token);
    if (!lock) return null;
    this.locks.delete(keyOf(drawingId, assetId));
    return lock;
  }

  releasePresence(presenceId: string): string[] {
    const affected = new Set<string>();
    for (const [key, lock] of this.locks) {
      if (lock.presenceId !== presenceId) continue;
      this.locks.delete(key);
      affected.add(lock.drawingId);
    }
    return [...affected];
  }

  snapshot(drawingId: string): PublicDocumentEditLock[] {
    return [...this.locks.values()]
      .filter((lock) => lock.drawingId === drawingId)
      .map(({ assetId, presenceId, ownerName }) => ({ assetId, presenceId, ownerName }));
  }
}
