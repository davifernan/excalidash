/**
 * Where a returned failure becomes something a person can hear.
 *
 * `CapabilityResult` is a return value, not an exception. That is deliberate --
 * a fallback is an expected outcome -- but it has a consequence worth saying
 * out loud: a non-ok result never throws, so outside its caller nobody sees it.
 * That lands hardest on `editor-changed`, which means "an upgrade broke a seam,
 * at a real user". A canary run cannot find that by construction, because it
 * only walks the paths we thought to write down.
 *
 * A subscription, not an import: the integration layer imports nothing from the
 * product or app layer. The app shell registers itself. With nobody listening
 * nothing changes -- no fallback depends on being heard.
 */

import type { DiagnosticEvent } from "../capabilities";
import type { CapabilityFailure } from "../errors";
import type { Unsubscribe } from "../types";

type Listener = (event: DiagnosticEvent) => void;

const listeners = new Set<Listener>();

export const onDiagnostic = (listener: Listener): Unsubscribe => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Report a failure.
 *
 * Carries the capability, the code, the chosen fallback and the package
 * version -- never board content, element text or a user identity. A listener
 * that throws must not take the caller down with it: the report is the least
 * important thing happening on that path.
 */
export const reportFailure = (failure: CapabilityFailure, packageVersion: string): void => {
  if (listeners.size === 0) return;
  const event: DiagnosticEvent = {
    seam: failure.seam,
    code: failure.code,
    fallback: failure.fallback,
    packageVersion,
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken listener is not worth failing a fallback over.
    }
  }
};

/** Test seam: forget every subscriber. */
export const resetDiagnostics = (): void => {
  listeners.clear();
};
