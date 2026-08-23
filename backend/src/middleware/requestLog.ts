import { Request, Response, NextFunction } from "express";

/**
 * Request logging, minus the noise that made it unreadable.
 *
 * The container health check runs every few seconds and used to write a line
 * per call, which was most of what the production log contained. A log nobody
 * reads because nothing can be found in it makes every other piece of error
 * handling that writes to it worthless.
 *
 * The match is exact, not a prefix: a prefix would also swallow anything that
 * merely starts with the same characters.
 */
const isHealthProbe = (path: string): boolean => path === "/health";

const LARGE_REQUEST_MB = 10;

export const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  if (isHealthProbe(req.path)) return next();

  const requestId = req.headers["x-request-id"] || "unknown";
  const contentLength = req.headers["content-length"];
  const userEmail = req.user?.email || "anonymous";

  if (contentLength) {
    const sizeInMB = parseInt(contentLength, 10) / 1024 / 1024;
    if (sizeInMB > LARGE_REQUEST_MB) {
      console.log(
        `[LARGE REQUEST] ${req.method} ${req.path} - ${sizeInMB.toFixed(
          2,
        )}MB - User: ${userEmail} - RequestID: ${requestId}`,
      );
    }
  }

  console.log(
    `[REQUEST] ${req.method} ${req.path} - User: ${userEmail} - IP: ${req.ip} - RequestID: ${requestId}`,
  );
  next();
};
