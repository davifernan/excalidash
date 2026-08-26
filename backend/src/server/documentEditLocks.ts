import { randomUUID } from "node:crypto";

export type DocumentEditLock = Readonly<{
  drawingId: string;
  assetId: string;
  presenceId: string;
  ownerName: string;
  token: string;
}>;

export type PublicDocumentEditLock = Omit<DocumentEditLock, "token" | "drawingId">;

export type DocumentEditDraft = Readonly<{
  drawingId: string;
  assetId: string;
  presenceId: string;
  revision: number;
  content: string;
}>;

export type PublicDocumentEditDraft = Omit<DocumentEditDraft, "drawingId">;

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
  private readonly drafts = new Map<string, DocumentEditDraft>();

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
    this.drafts.delete(key);
    return true;
  }

  releaseToken(drawingId: string, assetId: string, token: string): DocumentEditLock | null {
    const lock = this.validate(drawingId, assetId, token);
    if (!lock) return null;
    const key = keyOf(drawingId, assetId);
    this.locks.delete(key);
    this.drafts.delete(key);
    return lock;
  }

  releasePresence(presenceId: string): string[] {
    const affected = new Set<string>();
    for (const [key, lock] of this.locks) {
      if (lock.presenceId !== presenceId) continue;
      this.locks.delete(key);
      this.drafts.delete(key);
      affected.add(lock.drawingId);
    }
    return [...affected];
  }

  snapshot(drawingId: string): PublicDocumentEditLock[] {
    return [...this.locks.values()]
      .filter((lock) => lock.drawingId === drawingId)
      .map(({ assetId, presenceId, ownerName }) => ({ assetId, presenceId, ownerName }));
  }

  applyDraftPatch({
    drawingId,
    assetId,
    presenceId,
    token,
    revision,
    start,
    deleteCount,
    text,
    maxBytes,
  }: {
    drawingId: string;
    assetId: string;
    presenceId: string;
    token: string;
    revision: number;
    start: number;
    deleteCount: number;
    text: string;
    maxBytes: number;
  }): DocumentEditDraft | null {
    const lock = this.validate(drawingId, assetId, token);
    if (!lock || lock.presenceId !== presenceId) return null;
    const key = keyOf(drawingId, assetId);
    const current = this.drafts.get(key);
    if (revision !== (current?.revision ?? 0) + 1) return null;
    const base = current?.content ?? "";
    if (start > base.length || deleteCount > base.length - start) return null;
    const content = `${base.slice(0, start)}${text}${base.slice(start + deleteCount)}`;
    if (Buffer.byteLength(content, "utf8") > maxBytes) return null;
    const next = { drawingId, assetId, presenceId, revision, content };
    this.drafts.set(key, next);
    return next;
  }

  clearDraft(drawingId: string, assetId: string, presenceId: string, token: string): boolean {
    const lock = this.validate(drawingId, assetId, token);
    if (!lock || lock.presenceId !== presenceId) return false;
    return this.drafts.delete(keyOf(drawingId, assetId));
  }

  draftSnapshot(drawingId: string): PublicDocumentEditDraft[] {
    return [...this.drafts.values()]
      .filter((draft) => draft.drawingId === drawingId)
      .map(({ assetId, presenceId, revision, content }) => ({
        assetId,
        presenceId,
        revision,
        content,
      }));
  }
}
