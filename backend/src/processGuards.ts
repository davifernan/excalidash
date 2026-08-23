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
type ExitFn = (code: number) => void;

const describe = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack, name: value.name };
  }
  return value;
};

export const installProcessGuards = (
  target: NodeJS.EventEmitter = process,
  exit: ExitFn = (code) => process.exit(code),
): void => {
  target.on("uncaughtException", (error: unknown) => {
    console.error("Uncaught exception, exiting:", describe(error));
    exit(1);
  });

  target.on("unhandledRejection", (reason: unknown) => {
    console.error("Unhandled promise rejection, exiting:", describe(reason));
    exit(1);
  });
};
