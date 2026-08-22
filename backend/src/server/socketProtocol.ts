import {
  ELEMENT_UPDATE_TRAFFIC_LIMITS,
  SOCKET_LIMITS,
  type ElementUpdateTrafficLimits,
} from "../limits";

export { ELEMENT_UPDATE_TRAFFIC_LIMITS, SOCKET_LIMITS, type ElementUpdateTrafficLimits };

export const SOCKET_QUEUE_LIMITS = { joins: 8 } as const;

export type SceneBounds = [number, number, number, number];

export type { PresenceEntry as PresenceUser } from "./presenceRegistry";

export type CursorPayload = {
  drawingId: string;
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "up" | "down";
};

export type ElementUpdatePayload = {
  serializedBytes: number;
  drawingId: string;
  elements: unknown[];
  files?: Record<string, unknown>;
  elementOrder?: string[];
  elementOrderOmittedBytes?: number;
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

export const parseCursorPayload = (value: unknown): CursorPayload | null => {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const rawPointer = data.pointer;
  if (!drawingId || !rawPointer || typeof rawPointer !== "object") return null;
  const pointer = rawPointer as Record<string, unknown>;
  if (!isWorldCoordinate(pointer.x) || !isWorldCoordinate(pointer.y)) return null;
  if (pointer.tool !== "pointer" && pointer.tool !== "laser") return null;
  const button = data.button === "down" ? "down" : "up";
  return {
    drawingId,
    pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool },
    button,
  };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const serializedByteLength = (value: unknown): number | null => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
};

export type ElementUpdateLimitError = {
  code:
    | "payload-too-large"
    | "element-too-large"
    | "file-too-large"
    | "too-many-elements"
    | "too-many-files";
  message: string;
};

export const elementUpdateLimitError = (value: unknown): ElementUpdateLimitError | null => {
  if (!isPlainRecord(value)) return null;
  const serializedBytes = serializedByteLength(value);
  if (serializedBytes !== null && serializedBytes > SOCKET_LIMITS.elementUpdateBytes) {
    return {
      code: "payload-too-large",
      message: "element-update exceeds the per-event byte limit",
    };
  }
  if (Array.isArray(value.elements)) {
    if (value.elements.length > SOCKET_LIMITS.elementsPerUpdate) {
      return { code: "too-many-elements", message: "element-update contains too many elements" };
    }
    for (const element of value.elements) {
      const elementBytes = serializedByteLength(element);
      if (elementBytes !== null && elementBytes > SOCKET_LIMITS.elementBytes) {
        return {
          code: "element-too-large",
          message: "element-update contains an oversized element",
        };
      }
    }
  }
  if (isPlainRecord(value.files)) {
    if (Object.keys(value.files).length > SOCKET_LIMITS.filesPerUpdate) {
      return { code: "too-many-files", message: "element-update contains too many files" };
    }
    for (const file of Object.values(value.files)) {
      if (!isPlainRecord(file)) continue;
      const fileBytes = serializedByteLength(file);
      if (
        (typeof file.dataURL === "string" &&
          file.dataURL.length > SOCKET_LIMITS.fileDataUrlLength) ||
        (fileBytes !== null && fileBytes > SOCKET_LIMITS.fileBytes)
      ) {
        return { code: "file-too-large", message: "element-update contains an oversized file" };
      }
    }
  }
  return null;
};

const ELEMENT_NUMBER_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeWidth",
  "roughness",
  "opacity",
  "seed",
  "version",
  "versionNonce",
  "updated",
  "fontSize",
  "fontFamily",
] as const;
const ELEMENT_BOOLEAN_FIELDS = ["isDeleted", "locked", "autoResize"] as const;
const ELEMENT_STRING_FIELDS = [
  "index",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeStyle",
  "textAlign",
  "verticalAlign",
  "fileId",
] as const;

const hasPlausibleElementFields = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 200) return false;
  if (
    value.type !== undefined &&
    (typeof value.type !== "string" || value.type.length < 1 || value.type.length > 64)
  ) {
    return false;
  }
  for (const field of ELEMENT_NUMBER_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) return false;
    }
  }
  for (const field of ELEMENT_BOOLEAN_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null && typeof candidate !== "boolean")
      return false;
  }
  for (const field of ELEMENT_STRING_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null && typeof candidate !== "string")
      return false;
  }
  if (
    value.groupIds !== undefined &&
    value.groupIds !== null &&
    (!Array.isArray(value.groupIds) ||
      !value.groupIds.every((id) => typeof id === "string" && id.length <= 200))
  ) {
    return false;
  }
  if (
    value.points !== undefined &&
    value.points !== null &&
    (!Array.isArray(value.points) ||
      !value.points.every(
        (point) =>
          Array.isArray(point) &&
          point.length >= 2 &&
          point.length <= 3 &&
          point.every(
            (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate),
          ),
      ))
  ) {
    return false;
  }
  return true;
};

const hasPlausibleFileFields = (fileId: string, value: unknown): boolean => {
  if (!/^[\w-]{1,200}$/.test(fileId) || !isPlainRecord(value)) return false;
  if (value.id !== undefined && value.id !== fileId) return false;
  if (
    value.mimeType !== undefined &&
    (typeof value.mimeType !== "string" || value.mimeType.length > 200)
  ) {
    return false;
  }
  if (
    value.dataURL !== undefined &&
    (typeof value.dataURL !== "string" || value.dataURL.length > SOCKET_LIMITS.fileDataUrlLength)
  ) {
    return false;
  }
  for (const field of ["created", "lastRetrieved"] as const) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) return false;
    }
  }
  const bytes = serializedByteLength(value);
  return bytes !== null && bytes <= SOCKET_LIMITS.fileBytes;
};

export const parseElementUpdatePayload = (value: unknown): ElementUpdatePayload | null => {
  if (!isPlainRecord(value)) return null;
  // Measured before anything else: an oversized packet costs memory whatever it
  // turns out to contain.
  const serializedBytes = serializedByteLength(value);
  if (serializedBytes === null || serializedBytes > SOCKET_LIMITS.elementUpdateBytes) return null;
  const drawingId = parseDrawingId(value.drawingId);
  if (!drawingId || !Array.isArray(value.elements)) return null;
  if (value.elements.length > SOCKET_LIMITS.elementsPerUpdate) return null;
  for (const element of value.elements) {
    if (!hasPlausibleElementFields(element)) return null;
    const elementBytes = serializedByteLength(element);
    if (elementBytes === null || elementBytes > SOCKET_LIMITS.elementBytes) return null;
  }

  let files: Record<string, unknown> | undefined;
  if (value.files !== undefined) {
    if (!isPlainRecord(value.files)) return null;
    if (Object.keys(value.files).length > SOCKET_LIMITS.filesPerUpdate) return null;
    for (const [fileId, file] of Object.entries(value.files)) {
      if (!hasPlausibleFileFields(fileId, file)) return null;
    }
    files = value.files;
  }

  let elementOrder: string[] | undefined;
  let elementOrderOmittedBytes: number | undefined;
  if (value.elementOrder !== undefined) {
    if (
      !Array.isArray(value.elementOrder) ||
      !value.elementOrder.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
      ) ||
      // No element belongs in an ordering twice. Allowing it let a small
      // payload expand into one scene entry per mention on every receiver.
      new Set(value.elementOrder).size !== value.elementOrder.length
    ) {
      return null;
    }
    const byteLength = value.elementOrder.reduce(
      (total, id, index) => total + Buffer.byteLength(JSON.stringify(id)) + (index > 0 ? 1 : 0),
      2,
    );
    if (byteLength > SOCKET_LIMITS.elementOrderBytes) {
      elementOrderOmittedBytes = byteLength;
    } else {
      elementOrder = value.elementOrder;
    }
  } else if (value.elementOrderOmittedBytes !== undefined) {
    if (
      !Number.isSafeInteger(value.elementOrderOmittedBytes) ||
      (value.elementOrderOmittedBytes as number) <= SOCKET_LIMITS.elementOrderBytes
    ) {
      return null;
    }
    elementOrderOmittedBytes = value.elementOrderOmittedBytes as number;
  }

  return {
    drawingId,
    serializedBytes,
    elements: value.elements,
    files,
    elementOrder,
    elementOrderOmittedBytes,
  };
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
