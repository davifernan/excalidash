/**
 * Error handling middleware
 * Sanitizes error messages in production to prevent information leakage
 */
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * The correlation key is minted per request in index.ts and returned as the
 * X-Request-ID header. Every ordinary request is logged with it; the failing
 * one was the exception, which is precisely where a report and a log line need
 * to meet.
 */
const requestIdOf = (req: Request): string => {
  const raw = req.headers["x-request-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : "unknown";
};

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  code?: string;
}

/**
 * Error handler middleware
 * Should be added last in the middleware chain
 */
export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = requestIdOf(req);

  if (err.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      code: "upload-too-large",
      error: "Payload too large",
      message: "The upload exceeds the configured backend limit.",
      requestId,
    });
    return;
  }
  const statusCode = err.statusCode || 500;
  const isDevelopment = config.nodeEnv === "development";

  console.error("Error:", {
    message: err.message,
    stack: err.stack,
    statusCode,
    path: req.path,
    method: req.method,
    requestId,
    timestamp: new Date().toISOString(),
  });

  if (!isDevelopment) {
    if (statusCode >= 500) {
      res.status(statusCode).json({
        error: "Internal server error",
        message: "An error occurred while processing your request",
        requestId,
      });
      return;
    }

    res.status(statusCode).json({
      error: "Request error",
      message: err.isOperational ? err.message : "Invalid request",
      requestId,
    });
    return;
  }

  res.status(statusCode).json({
    error: err.message,
    stack: err.stack,
    statusCode,
    requestId,
  });
};

/**
 * Async error wrapper
 * Wraps async route handlers to catch errors
 */
export const asyncHandler = <T = void>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
