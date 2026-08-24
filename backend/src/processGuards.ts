/**
 * Last-resort visibility for the two failures that end the process.
 *
 * Node's defaults already end the process for both an uncaught exception and
 * an unhandled rejection, but what reaches the log is not something you can
 * work with, and on a restarting container the restart is all that is left.
 *
 * Registering a listener for either event REPLACES that default. Exiting here
 * is therefore not an extra: without it, this file would turn a crash into a
 * process that keeps running in an unknown state, which is worse than the
 * silence it set out to fix.
 */
import { logger } from "./logger";

type ExitFn = (code: number) => void;

export const installProcessGuards = (
  target: NodeJS.EventEmitter = process,
  exit: ExitFn = (code) => process.exit(code),
): void => {
  // No local Error-to-{name,message,stack} conversion here: logger.ts's own
  // replacer already does this for every caller, for any Error nested
  // anywhere in a fields object -- not just a top-level one. A second copy
  // of that logic next to the centralization that exists to replace it
  // defeats the point (Hans-Friedrich review on #73).
  target.on("uncaughtException", (error: unknown) => {
    logger.error("Uncaught exception, exiting", { error });
    exit(1);
  });

  target.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection, exiting", { reason });
    exit(1);
  });
};
