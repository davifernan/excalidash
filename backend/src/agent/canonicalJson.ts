import { createHash, timingSafeEqual } from "node:crypto";

/** Stable JSON for revision, argument, result, and audit hashes. */
export const canonicalJson = (value: unknown): string => {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, visit(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(visit(value));
};

export const sha256Json = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const secretsEqual = (presented: string, expectedHash: string): boolean => {
  const actual = Buffer.from(sha256Text(presented), "hex");
  const expected = /^[a-f0-9]{64}$/i.test(expectedHash)
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(actual.length);
  return timingSafeEqual(actual, expected) && /^[a-f0-9]{64}$/i.test(expectedHash);
};
