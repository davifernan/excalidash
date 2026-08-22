import { SOCKET_LIMITS } from "../limits";

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const serializedByteLength = (value: unknown): number | null => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
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

export const hasPlausibleElementFields = (value: unknown): value is Record<string, unknown> => {
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
    if (candidate !== undefined && candidate !== null && typeof candidate !== "boolean") {
      return false;
    }
  }
  for (const field of ELEMENT_STRING_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null && typeof candidate !== "string") {
      return false;
    }
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

const hasPlausibleFileMetadata = (
  fileId: string,
  value: unknown,
): value is Record<string, unknown> => {
  if (!/^[\w-]{1,200}$/.test(fileId) || !isPlainRecord(value)) return false;
  if (value.id !== undefined && value.id !== fileId) return false;
  if (
    value.mimeType !== undefined &&
    (typeof value.mimeType !== "string" || value.mimeType.length > 200)
  ) {
    return false;
  }
  if (value.dataURL !== undefined && typeof value.dataURL !== "string") return false;
  for (const field of ["created", "lastRetrieved"] as const) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) return false;
    }
  }
  return true;
};

export const hasPlausibleFileFields = (fileId: string, value: unknown): boolean => {
  if (!hasPlausibleFileMetadata(fileId, value)) return false;
  if (typeof value.dataURL === "string" && value.dataURL.length > SOCKET_LIMITS.fileDataUrlLength) {
    return false;
  }
  const bytes = serializedByteLength(value);
  return bytes !== null && bytes <= SOCKET_LIMITS.fileBytes;
};

const hasPlausibleDrawingId = (value: unknown): boolean =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= SOCKET_LIMITS.drawingIdLength;

const hasPlausibleElementUpdateShape = (
  value: unknown,
): value is Record<string, unknown> & { elements: unknown[] } => {
  if (!isPlainRecord(value) || !hasPlausibleDrawingId(value.drawingId)) return false;
  if (!Array.isArray(value.elements) || !value.elements.every(hasPlausibleElementFields)) {
    return false;
  }
  if (value.files !== undefined) {
    if (!isPlainRecord(value.files)) return false;
    for (const [fileId, file] of Object.entries(value.files)) {
      if (!hasPlausibleFileMetadata(fileId, file)) return false;
    }
  }
  if (value.elementOrder !== undefined) {
    if (
      !Array.isArray(value.elementOrder) ||
      !value.elementOrder.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
      ) ||
      new Set(value.elementOrder).size !== value.elementOrder.length
    ) {
      return false;
    }
  } else if (
    value.elementOrderOmittedBytes !== undefined &&
    (!Number.isSafeInteger(value.elementOrderOmittedBytes) ||
      (value.elementOrderOmittedBytes as number) <= SOCKET_LIMITS.elementOrderBytes)
  ) {
    return false;
  }
  return true;
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
  // A malformed packet remains a hard failure even when it also crosses a
  // declared ceiling. Otherwise clients could add invalid fields to turn the
  // disconnect policy into an unlimited stream of ordinary size refusals.
  if (!hasPlausibleElementUpdateShape(value)) return null;
  const serializedBytes = serializedByteLength(value);
  if (serializedBytes !== null && serializedBytes > SOCKET_LIMITS.elementUpdateBytes) {
    return {
      code: "payload-too-large",
      message: "element-update exceeds the per-event byte limit",
    };
  }
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
  if (isPlainRecord(value.files)) {
    if (Object.keys(value.files).length > SOCKET_LIMITS.filesPerUpdate) {
      return { code: "too-many-files", message: "element-update contains too many files" };
    }
    for (const file of Object.values(value.files)) {
      if (!isPlainRecord(file)) return null;
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
