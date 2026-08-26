/**
 * Who is presenting a drawing to the rest of the room, right now.
 *
 * This is Follow with an authority on top (docs/product/COLLABORATION_NAVIGATION.md,
 * "What M4 can take over"), not a second presence concept: exactly one
 * presenter per drawing, and every other connected socket is audience by
 * virtue of being in the room -- there is no per-viewer opt-in edge to
 * maintain, no N-fold `follow-user` command, and nothing here is persisted
 * (same convention as presenceRegistry.ts: presence is a fact about open
 * connections).
 *
 * The revision counter is not a client-supplied optimistic-concurrency token.
 * Only the current presenter's socket is authorized to advance a frame or pan
 * (`socketPresenter.ts` checks `isPresenter` before calling in), so there is
 * no concurrent-writer race to arbitrate -- a deposed presenter's socket is
 * simply no longer recognized the moment `stop`/`takeover` runs, synchronously,
 * with no `await` in between the check and the write. `revision` exists for
 * clients: a monotonic number they can use to detect "have I already applied
 * this" across a reconnect, without needing to diff the whole snapshot.
 */
import type { SceneBounds } from "./socketProtocol";
import type { PresenterSnapshot, PresenterStatus } from "@excalidash/domain/collaboration";

export type { PresenterSnapshot, PresenterStatus } from "@excalidash/domain/collaboration";

type PresenterState = {
  presenterSocketId: string;
  presenterName: string;
  frameId: string | null;
  bounds: SceneBounds | null;
  revision: number;
};

/**
 * Tagged with a string `status`, not a boolean `ok`: this backend's
 * tsconfig does not set `strictNullChecks`, and without it TypeScript's
 * control-flow narrowing does not reliably discriminate a `true | false`
 * literal tag (confirmed against tsc 5.9.3 -- `if (!result.ok)` left
 * `result.reason` unresolvable on the `status: "rejected"` branch). A
 * string tag narrows correctly either way, and it is what every sibling
 * result type in this directory already uses (`WorkshopTimerStatus`,
 * `RoomEventResult`).
 */
export type PresenterCommandResult =
  | { readonly status: "applied"; readonly snapshot: PresenterSnapshot; readonly changed: boolean }
  /**
   * `presenter-active`: someone else already holds the room.
   * `not-presenting`: the caller is not (or no longer) the current presenter,
   * so an advance/pan/self-stop has nothing to act on.
   */
  | { readonly status: "rejected"; readonly reason: "presenter-active" | "not-presenting" };

const idleSnapshot = (drawingId: string, revision: number): PresenterSnapshot => ({
  drawingId,
  status: "idle",
  presenterPresenceId: null,
  presenterName: null,
  frameId: null,
  bounds: null,
  revision,
});

const notesKey = (frameId: string | null): string => frameId ?? "";

export class PresenterRegistry {
  private readonly byDrawing = new Map<string, PresenterState>();
  /**
   * Presenter notes, kept entirely apart from `PresenterSnapshot`.
   *
   * They must never reach the room broadcast: `socketPresenter.ts` only ever
   * pushes a note directly to the presenter's own socket, and this map is
   * never read by anything that emits to a room. Ephemeral like everything
   * else in this file -- notes live for the process's lifetime, not across a
   * restart, and `clear()` (called when a drawing empties out) drops them
   * with the rest of the session's state.
   */
  private readonly notesByDrawing = new Map<string, Map<string, string>>();

  snapshot(drawingId: string): PresenterSnapshot {
    const state = this.byDrawing.get(drawingId);
    if (!state) return idleSnapshot(drawingId, 0);
    return {
      drawingId,
      status: "presenting",
      presenterPresenceId: state.presenterSocketId,
      presenterName: state.presenterName,
      frameId: state.frameId,
      bounds: state.bounds,
      revision: state.revision,
    };
  }

  isPresenter(drawingId: string, socketId: string): boolean {
    return this.byDrawing.get(drawingId)?.presenterSocketId === socketId;
  }

  /**
   * Become the presenter. Idempotent when the caller already holds the role
   * (`changed: false`, no revision bump -- a duplicate "start" from the same
   * tab, say a reconnect race, must not look like a fresh presentation to
   * anyone watching the revision). Rejected when somebody else does, unless
   * `force` -- the moderator takeover path.
   */
  start(
    drawingId: string,
    socketId: string,
    presenterName: string,
    options?: { readonly force?: boolean },
  ): PresenterCommandResult {
    const existing = this.byDrawing.get(drawingId);
    if (existing?.presenterSocketId === socketId) {
      return { status: "applied", snapshot: this.snapshot(drawingId), changed: false };
    }
    if (existing && !options?.force) {
      return { status: "rejected", reason: "presenter-active" };
    }
    this.byDrawing.set(drawingId, {
      presenterSocketId: socketId,
      presenterName,
      frameId: null,
      bounds: null,
      revision: (existing?.revision ?? 0) + 1,
    });
    return { status: "applied", snapshot: this.snapshot(drawingId), changed: true };
  }

  /**
   * Move the shared view. `frameId: null` is a freeform pan away from any
   * named frame -- the same channel carries both, distinguished by whether a
   * frame is named, so the client does not need a second event to tell "the
   * presenter jumped to frame 3" from "the presenter is panning around".
   */
  advance(
    drawingId: string,
    socketId: string,
    frameId: string | null,
    bounds: SceneBounds,
  ): PresenterCommandResult {
    const state = this.byDrawing.get(drawingId);
    if (!state || state.presenterSocketId !== socketId) {
      return { status: "rejected", reason: "not-presenting" };
    }
    state.frameId = frameId;
    state.bounds = bounds;
    state.revision += 1;
    return { status: "applied", snapshot: this.snapshot(drawingId), changed: true };
  }

  /** Stop presenting. `force` lets the drawing owner end someone else's turn. */
  stop(
    drawingId: string,
    socketId: string,
    options?: { readonly force?: boolean },
  ): PresenterCommandResult {
    const state = this.byDrawing.get(drawingId);
    if (!state) return { status: "applied", snapshot: this.snapshot(drawingId), changed: false };
    if (state.presenterSocketId !== socketId && !options?.force) {
      return { status: "rejected", reason: "not-presenting" };
    }
    this.byDrawing.delete(drawingId);
    return {
      status: "applied",
      snapshot: idleSnapshot(drawingId, state.revision + 1),
      changed: true,
    };
  }

  /**
   * The presenter's own socket is gone -- a real disconnect, an access
   * revocation, or a board switch (`removeFromDrawing`'s reasons). Ends
   * presenting the same way `stop` does, but never rejects: there is no
   * requester to answer, only room state to correct. A no-op when the socket
   * leaving was not the presenter.
   */
  clearSocket(drawingId: string, socketId: string): PresenterSnapshot | null {
    const state = this.byDrawing.get(drawingId);
    if (!state || state.presenterSocketId !== socketId) return null;
    this.byDrawing.delete(drawingId);
    return idleSnapshot(drawingId, state.revision + 1);
  }

  clear(drawingId: string): void {
    this.byDrawing.delete(drawingId);
    this.notesByDrawing.delete(drawingId);
  }

  /** Only ever called from a handler that has already checked `isPresenter`. */
  getNotes(drawingId: string, frameId: string | null): string {
    return this.notesByDrawing.get(drawingId)?.get(notesKey(frameId)) ?? "";
  }

  setNotes(drawingId: string, frameId: string | null, text: string): void {
    let byFrame = this.notesByDrawing.get(drawingId);
    if (!byFrame) {
      byFrame = new Map();
      this.notesByDrawing.set(drawingId, byFrame);
    }
    byFrame.set(notesKey(frameId), text);
  }
}
