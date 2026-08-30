/**
 * The current lifecycle of a soak actor when no step is in flight.
 *
 * `lastStep`, `cycles`, and `lastHeartbeatAt` are historical observations;
 * none can say whether an actor is now selecting its next action or waiting
 * between cycles. This state is deliberately written at those boundaries so
 * the watchdog reports current work rather than inferring it after the fact.
 */
export type SoakLifecycleState = "transition" | "intercycle_wait";

export type PageSwitchWatchdogTrace = {
  phase: string;
  outcome: string;
};

export type WatchdogLifecycleActor = {
  inFlightStep: string | null;
  lifecycle: SoakLifecycleState;
  pageSwitchTraces: readonly PageSwitchWatchdogTrace[];
};

export const enterTransition = (actor: WatchdogLifecycleActor) => {
  actor.lifecycle = "transition";
};

export const enterIntercycleWait = (actor: WatchdogLifecycleActor) => {
  actor.inFlightStep = null;
  actor.lifecycle = "intercycle_wait";
};

export const beginInFlightStep = (actor: WatchdogLifecycleActor, step: string) => {
  actor.lifecycle = "transition";
  actor.inFlightStep = step;
};

export const finishInFlightStep = (actor: WatchdogLifecycleActor) => {
  actor.inFlightStep = null;
  actor.lifecycle = "transition";
};

/** The precise state to retain in a watchdog violation. */
export const watchdogDiagnosticStep = (actor: WatchdogLifecycleActor): string => {
  const activePageSwitch = [...actor.pageSwitchTraces]
    .reverse()
    .find((trace) => trace.outcome === "started");
  if (actor.inFlightStep === "page_switch" && activePageSwitch) {
    return `page_switch.${activePageSwitch.phase}`;
  }
  return actor.inFlightStep ?? actor.lifecycle;
};
