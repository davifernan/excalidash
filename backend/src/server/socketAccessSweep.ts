import { logger } from "../logger";

export const startNonOverlappingSocketAccessSweep = (
  recheck: () => Promise<void>,
  intervalMs: number,
) => {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void recheck()
      .catch((error) => {
        logger.error("Periodic socket access recheck failed", { error });
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref?.();
  return timer;
};
