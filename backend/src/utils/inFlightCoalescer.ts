/**
 * Coalesces concurrent calls for the same key into one shared promise: the
 * first caller starts the work, later callers for the same key get that
 * same promise back instead of starting their own, until it settles either
 * way. Once settled -- success or failure -- the next caller starts fresh
 * work; nothing is cached beyond the in-flight window itself.
 *
 * Cleanup is always identity-checked (`inFlight.get(key) === operation`),
 * not unconditional: only the exact operation a caller started clears its
 * own slot, so a slot a newer operation has already replaced can never be
 * cleared out from under it. A single global target (no natural per-call
 * key) still uses this the same way, with one fixed key.
 *
 * This is only safe for work whose result would be the same regardless of
 * which caller's timing produced it -- idempotent, freshly-refetchable
 * work. It is NOT safe for anything a caller must observe fresh: coalescing
 * `backend/src/auth/authMode.ts`'s system-config upsert once did exactly
 * that (removed in commit fbc6270d) because a concurrent admin toggle could
 * make a later status request see the shared, already-stale result instead
 * of its own fresh read.
 *
 * Three lookalikes in this repo are deliberately NOT built on this helper,
 * each for its own documented reason at the call site:
 * `backend/src/auth/oidcClient.ts` (clears only on failure, caches forever
 * on success), `backend/src/routes/dashboard/drawingRuntimeRoutes.ts`
 * (a boolean re-entrancy flag, no stored promise at all), and
 * `backend/src/assets/pageCache.ts` (per-caller `AbortSignal` cancellation
 * and waiter refcounting on top of coalescing).
 */
export const createInFlightCoalescer = <T>() => {
  const inFlight = new Map<string, Promise<T>>();

  const run = (key: string, start: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    // `start` may throw synchronously (a guard check before any await, say)
    // rather than return a rejected promise. Normalize both to the same
    // outcome so a caller never has to know which shape `start` used, and so
    // no stale entry is ever left in `inFlight` for a start that never
    // actually began.
    let operation: Promise<T>;
    try {
      operation = start();
    } catch (error) {
      return Promise.reject(error);
    }
    inFlight.set(key, operation);
    const clear = () => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    };
    void operation.then(clear, clear);
    return operation;
  };

  /**
   * True while a call for `key` is still in flight -- for a caller that
   * needs to know whether it is about to join existing work (e.g. a
   * diagnostic log), not to make the join/start decision itself. `run`
   * remains the only place that decides.
   */
  const has = (key: string): boolean => inFlight.has(key);

  return { run, has };
};
