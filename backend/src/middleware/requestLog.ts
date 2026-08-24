import { Request, Response, NextFunction } from "express";
import { config } from "../config";

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
 *
 * A per-request line at every level has the same failure mode the health
 * probe did: the production default (`config.logLevel === "info"`) keeps
 * only the large-request anomaly line, which is the signal someone actually
 * goes looking for. The full per-request line is `debug`-only -- the default
 * in development, or an explicit `LOG_LEVEL=debug` when a specific report
 * needs tracing in production without a redeploy.
 */
const isHealthProbe = (path: string): boolean => path === "/health";

const LARGE_REQUEST_MB = 10;

export const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  if (isHealthProbe(req.path) || config.logLevel === "silent") return next();

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

  if (config.logLevel === "debug") {
    console.log(
      `[REQUEST] ${req.method} ${req.path} - User: ${userEmail} - IP: ${req.ip} - RequestID: ${requestId}`,
    );
  }
  next();
};
