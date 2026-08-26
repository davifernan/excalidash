import {
  ELEMENT_UPDATE_TRAFFIC_LIMITS,
  SOCKET_LIMITS,
  type ElementUpdateTrafficLimits,
} from "../limits";
import {
  elementUpdateLimitError,
  isPlainRecord,
  parseElementUpdateShape,
  type ElementUpdateLimitError,
} from "./socketElementUpdateLimits";
import {
  cursorUpdateSchema,
  type CursorUpdate,
  type ElementUpdatePayload as ElementUpdateWirePayload,
  type SceneBounds,
} from "@excalidash/domain/collaboration";

export { ELEMENT_UPDATE_TRAFFIC_LIMITS, SOCKET_LIMITS, type ElementUpdateTrafficLimits };
export { elementUpdateLimitError, type ElementUpdateLimitError };

export const SOCKET_QUEUE_LIMITS = { joins: 8 } as const;

export type { RoomEventError } from "@excalidash/domain/collaboration";
import type { RoomEventError } from "@excalidash/domain/collaboration";

/**
 * Returned by a `parse` function in place of `null` when the refusal reason
 * is already known -- an oversized-but-otherwise-plausible payload, say --
 * so the caller can report it without re-deriving it from the raw value.
 */
export class RoomEventParseFailure {
  constructor(public readonly error: RoomEventError | null) {}
}

export type { SceneBounds } from "@excalidash/domain/collaboration";

export type { PresenceEntry as PresenceUser } from "./presenceRegistry";

export type ParsedElementUpdatePayload = ElementUpdateWirePayload & {
  serializedBytes: number;
};

export const parseDrawingId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const drawingId = value.trim();
  if (!drawingId || drawingId.length > SOCKET_LIMITS.drawingIdLength) return null;
  return drawingId;
};

const isWorldCoordinate = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= SOCKET_LIMITS.coordinateAbs;

export const parseSceneBounds = (value: unknown): SceneBounds | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x1, y1, x2, y2] = value;
  if (
    !isWorldCoordinate(x1) ||
    !isWorldCoordinate(y1) ||
    !isWorldCoordinate(x2) ||
    !isWorldCoordinate(y2)
  ) {
    return null;
  }
  const width = x2 - x1;
  const height = y2 - y1;
  if (
    width <= 0 ||
    height <= 0 ||
    width > SOCKET_LIMITS.viewportSpan ||
    height > SOCKET_LIMITS.viewportSpan
  ) {
    return null;
  }
  return [x1, y1, x2, y2];
};

export const parseCursorPayload = (value: unknown): CursorUpdate | null => {
  const parsed = cursorUpdateSchema.safeParse(value);
  if (!parsed.success) return null;
  const { pointer } = parsed.data;
  const drawingId = parseDrawingId(parsed.data.drawingId);
  if (!drawingId || !isWorldCoordinate(pointer.x) || !isWorldCoordinate(pointer.y)) return null;
  return {
    drawingId,
    pointer,
    button: parsed.data.button,
  };
};

/**
 * Shape and size are both decided by the single pass in
 * `parseElementUpdateShape`. A rejection already carries its precise reason
 * (or `null` for a plain malformed packet), so the socket registration below
 * can report it without a second pass over the raw value. This is the entry
 * point wired into the live event; `parseElementUpdatePayload` below is the
 * plain-boolean-shaped variant kept for callers that only care whether the
 * payload was accepted.
 */
export const parseElementUpdateEvent = (
  value: unknown,
): ParsedElementUpdatePayload | RoomEventParseFailure => {
  const shapeResult = parseElementUpdateShape(value);
  if (shapeResult.error !== undefined) return new RoomEventParseFailure(shapeResult.error);
  const { value: shaped, serializedBytes } = shapeResult;

  // Already validated by parseElementUpdateShape; re-trimming is cheap and
  // avoids threading a second, differently-shaped "narrowed value" type
  // through the rest of the codebase.
  const drawingId = parseDrawingId(shaped.drawingId) as string;

  const files = isPlainRecord(shaped.files) ? shaped.files : undefined;

  let elementOrder: string[] | undefined;
  let elementOrderOmittedBytes: number | undefined;
  if (shaped.elementOrder !== undefined) {
    const order = shaped.elementOrder as string[];
    const byteLength = order.reduce(
      (total, id, index) => total + Buffer.byteLength(JSON.stringify(id)) + (index > 0 ? 1 : 0),
      2,
    );
    if (byteLength > SOCKET_LIMITS.elementOrderBytes) {
      elementOrderOmittedBytes = byteLength;
    } else {
      elementOrder = order;
    }
  } else if (shaped.elementOrderOmittedBytes !== undefined) {
    elementOrderOmittedBytes = shaped.elementOrderOmittedBytes as number;
  }

  return {
    drawingId,
    serializedBytes,
    elements: shaped.elements as Record<string, unknown>[],
    files,
    elementOrder,
    elementOrderOmittedBytes,
  };
};

/** Legacy accept/reject contract for callers that don't need the refusal reason. */
export const parseElementUpdatePayload = (value: unknown): ParsedElementUpdatePayload | null => {
  const result = parseElementUpdateEvent(value);
  return result instanceof RoomEventParseFailure ? null : result;
};

export const createRateLimiter = (limit: number, windowMs: number) => {
  let windowStartedAt = 0;
  let count = 0;
  return (now = Date.now()): boolean => {
    if (now - windowStartedAt >= windowMs) {
      windowStartedAt = now;
      count = 0;
    }
    count += 1;
    return count <= limit;
  };
};

export const createKeyedRateLimiter = (limit: number, windowMs: number, maxKeys = 10_000) => {
  const buckets = new Map<string, { windowStartedAt: number; count: number }>();
  return (key: string, now = Date.now()): boolean => {
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      if (!bucket && buckets.size >= maxKeys) {
        for (const [candidateKey, candidate] of buckets) {
          if (now - candidate.windowStartedAt >= windowMs) buckets.delete(candidateKey);
        }
        // Refusing a new bucket is safer than evicting a live one and letting
        // an attacker reset limits by cycling through disposable addresses.
        if (buckets.size >= maxKeys) return false;
      }
      bucket = { windowStartedAt: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
};

export const createKeyedByteLimiter = (limit: number, windowMs: number, maxKeys = 10_000) => {
  const buckets = new Map<string, { windowStartedAt: number; bytes: number }>();
  return (key: string, bytes: number, now = Date.now()): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      if (!bucket && buckets.size >= maxKeys) {
        for (const [candidateKey, candidate] of buckets) {
          if (now - candidate.windowStartedAt >= windowMs) buckets.delete(candidateKey);
        }
        if (buckets.size >= maxKeys) return false;
      }
      bucket = { windowStartedAt: now, bytes: 0 };
      buckets.set(key, bucket);
    }
    // Charge the crossing event too. It is not relayed, and further traffic
    // from the actor cannot probe for a smaller remainder in this window.
    bucket.bytes += bytes;
    return bucket.bytes <= limit;
  };
};
