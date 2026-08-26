import type { Request } from "express";

/**
 * The request ID is minted in index.ts and is absent only before the request
 * middleware has run. Keep its header shape in one place so route handlers do
 * not each need an unsafe Express header cast.
 */
export const requestIdOf = (req: Request): string | undefined => {
  const raw = req.headers["x-request-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
};

export const requestIdOrUnknown = (req: Request): string => requestIdOf(req) ?? "unknown";
