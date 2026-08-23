import type { Socket } from "socket.io";
import { createRateLimiter, RoomEventParseFailure, type RoomEventError } from "./socketProtocol";

export type { RoomEventError };
export type RoomEventPayload = { drawingId: string };
export type RoomEventAck = (
  value: { ok: true; warning?: RoomEventError } | { ok: false; error: RoomEventError },
) => void;
export type RoomEventResult = { warning: RoomEventError } | { error: RoomEventError } | void;

const ROOM_EVENT_FEEDBACK_EVENT = "room-event-error";
const HARD_FAILURE_LIMIT = 10;
const HARD_FAILURE_WINDOW_MS = 60_000;
const hardFailures = new WeakMap<Socket, { windowStartedAt: number; count: number }>();

const reportHardFailure = (
  socket: Socket,
  event: string,
  error: RoomEventError,
  ack?: RoomEventAck,
) => {
  if (ack) ack({ ok: false, error });
  else socket.emit(ROOM_EVENT_FEEDBACK_EVENT, { event, error });

  const now = Date.now();
  let failures = hardFailures.get(socket);
  if (!failures || now - failures.windowStartedAt >= HARD_FAILURE_WINDOW_MS) {
    failures = { windowStartedAt: now, count: 0 };
    hardFailures.set(socket, failures);
  }
  failures.count += 1;
  // A normal client cannot produce a stream of invalid packets. Closing the
  // connection bounds error traffic while every packet the server accepts is
  // still answered exactly once.
  if (failures.count >= HARD_FAILURE_LIMIT) socket.disconnect(true);
};

export const createRoomEventFeedback = (socket: Socket, event: string, windowMs: number) => {
  let nextRateLimitNoticeAt = 0;
  return {
    invalid(ack?: RoomEventAck) {
      reportHardFailure(
        socket,
        event,
        { code: "invalid-request", message: `Invalid ${event} payload` },
        ack,
      );
    },
    rateLimited(ack?: RoomEventAck) {
      const now = Date.now();
      const error: RoomEventError = {
        code: "rate-limited",
        message: `${event} rate limit exceeded`,
      };
      if (ack) {
        ack({ ok: false, error });
        return true;
      }
      if (now < nextRateLimitNoticeAt) return false;
      nextRateLimitNoticeAt = now + windowMs;
      socket.emit(ROOM_EVENT_FEEDBACK_EVENT, { event, error });
      return true;
    },
    /**
     * A budget refusal, not a malformed packet. It answers the ack so the
     * sender stops waiting on its timeout and knows the change never went out,
     * and it never counts toward the hard-failure limit: a board that has grown
     * large is not a client behaving badly, and disconnecting it would turn a
     * throughput ceiling into a lockout.
     */
    refused(ack?: RoomEventAck) {
      const error: RoomEventError = {
        code: "rate-limited",
        message: `${event} rate limit exceeded`,
      };
      if (ack) {
        ack({ ok: false, error });
        return;
      }
      const now = Date.now();
      if (now < nextRateLimitNoticeAt) return;
      nextRateLimitNoticeAt = now + windowMs;
      socket.emit(ROOM_EVENT_FEEDBACK_EVENT, { event, error });
    },
    /**
     * `hardFailure` marks a rejection class a well-behaved client cannot
     * produce repeatedly -- a payload that is plausibly shaped but still
     * breaches a declared limit. Ordinary business refusals (access denied,
     * a handler error) stay off this counter: those can recur for a client
     * doing nothing wrong, and counting them would turn an occasional
     * legitimate refusal into a disconnect.
     */
    rejected(error: RoomEventError, ack?: RoomEventAck, options?: { hardFailure?: boolean }) {
      if (options?.hardFailure) {
        reportHardFailure(socket, event, error, ack);
        return;
      }
      if (ack) ack({ ok: false, error });
      else socket.emit(ROOM_EVENT_FEEDBACK_EVENT, { event, error });
    },
    succeeded(ack?: RoomEventAck, warning?: RoomEventError) {
      if (warning) {
        if (ack) ack({ ok: true, warning });
        else socket.emit(ROOM_EVENT_FEEDBACK_EVENT, { event, error: warning });
        return;
      }
      ack?.({ ok: true });
    },
  };
};

type RegisterAuthorizedRoomEventOptions<Payload extends RoomEventPayload> = {
  socket: Socket;
  event: string;
  limit: number;
  windowMs: number;
  /**
   * A rejection may return `RoomEventParseFailure` instead of `null` when
   * the reason is already known -- a payload that is plausibly shaped but
   * breaches a declared limit, say -- so it can be reported without a
   * second pass over the raw value.
   */
  parse: (value: unknown) => Payload | RoomEventParseFailure | null;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
  requireEdit?: boolean;
  /**
   * A budget that outlives this socket, checked in addition to the
   * per-connection one rather than instead of it.
   *
   * The per-connection limiter is fine for anything a client only gains by
   * doing quickly. It is not fine where opening a second tab hands out a second
   * budget: there the caller passes a limiter keyed by account or address, so
   * reconnecting -- or connecting fifty times -- buys nothing. Both apply,
   * because a shared budget large enough for several tabs would otherwise let
   * a single tab spend all of it.
   */
  allow?: () => boolean;
  /**
   * A budget that can only be spent once the payload is known -- bytes rather
   * than events. Rate alone is the wrong unit for anything that carries a
   * scene: 120 small updates a second are harmless and 120 large ones are not.
   *
   * Checked after parsing and before the access round trip, and answered as a
   * refusal rather than silence, so the sender knows to try again.
   */
  allowPayload?: (payload: Payload) => boolean;
  /**
   * Lets a payload past the per-event limiter. Only for messages that can
   * merely remove something the sender already put there -- a clear cannot add
   * anything, and losing it leaves the sender's own leftovers on every other
   * screen.
   */
  rateLimitExempt?: (value: unknown) => boolean;
  /** Sees each admitted event synchronously, before it enters the queue. */
  onRateLimitAdmitted?: (value: unknown) => void;
  handle: (payload: Payload) => RoomEventResult | Promise<RoomEventResult>;
};

/**
 * The only registration path for ordinary drawing-room events. Rate limiting
 * happens before parsing so malformed traffic consumes the same budget, and
 * the feature handler cannot run until fresh room access has been checked.
 *
 * Handlers for one event on one socket run strictly in arrival order. The
 * access check is a database round trip, so two messages sent a millisecond
 * apart can finish theirs in either order -- and the consequences are not
 * cosmetic: the "stop talking" that follows a chat message could be applied
 * first, leaving a bubble on everyone's screen with no way to clear it, and an
 * older selection could land after a newer one. Each registration therefore
 * keeps its own tail and appends to it, which costs one promise per message and
 * makes the order the sender's rather than the database's.
 */
export const registerAuthorizedRoomEvent = <Payload extends RoomEventPayload>({
  socket,
  event,
  limit,
  windowMs,
  parse,
  requireAccess,
  requireEdit = false,
  allow: sharedAllow,
  allowPayload,
  rateLimitExempt,
  onRateLimitAdmitted,
  handle,
}: RegisterAuthorizedRoomEventOptions<Payload>): void => {
  const allowThisConnection = createRateLimiter(limit, windowMs);
  const allow = () => allowThisConnection() && (sharedAllow?.() ?? true);
  const feedback = createRoomEventFeedback(socket, event, windowMs);
  let tail: Promise<void> = Promise.resolve();
  socket.on(event, (value: unknown, ack?: RoomEventAck) => {
    // Rate limiting stays synchronous and outside the queue: refusing traffic
    // is the one thing that must not wait behind the traffic it is refusing.
    if (!rateLimitExempt?.(value) && !allow()) {
      feedback.rateLimited(ack);
      return;
    }
    onRateLimitAdmitted?.(value);
    tail = tail.then(async () => {
      const parsed = parse(value);
      if (parsed === null || parsed instanceof RoomEventParseFailure) {
        const limitError = parsed instanceof RoomEventParseFailure ? parsed.error : null;
        if (limitError) feedback.rejected(limitError, ack, { hardFailure: true });
        else feedback.invalid(ack);
        return;
      }
      const payload = parsed;
      if (allowPayload && !allowPayload(payload)) {
        feedback.refused(ack);
        return;
      }
      if (!(await requireAccess(socket, payload.drawingId, requireEdit))) {
        // The access seam already reports legacy fire-and-forget commands. An
        // acknowledged command needs the same refusal in-band so it does not
        // wait until timeout, without emitting a second public error event.
        if (ack) {
          feedback.rejected({ code: "access-denied", message: `${event} access denied` }, ack);
        }
        return;
      }
      const result = await handle(payload);
      if (result && "error" in result) feedback.rejected(result.error, ack);
      else feedback.succeeded(ack, result && "warning" in result ? result.warning : undefined);
    });
    // A thrown handler must not poison the tail for everything after it, and
    // an acknowledged command must never be left waiting until client timeout.
    tail = tail.catch((error) => {
      console.error(`Room event ${event} failed:`, error);
      feedback.rejected(
        { code: "internal-error", message: `${event} could not be completed` },
        ack,
      );
    });
    // Socket.IO ignores what a listener returns; tests await it, which is the
    // only way they can observe work that is now deliberately deferred.
    return tail;
  });
};
