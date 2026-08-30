import { expect, test } from "@playwright/test";
import {
  beginInFlightStep,
  enterIntercycleWait,
  enterTransition,
  finishInFlightStep,
  watchdogDiagnosticStep,
  type WatchdogLifecycleActor,
} from "./helpers/soakWatchdogLifecycle";

const actor = (): WatchdogLifecycleActor => ({
  inFlightStep: null,
  lifecycle: "transition",
  pageSwitchTraces: [],
});

test.describe("NIL-698 soak watchdog lifecycle diagnostics", () => {
  test("names an intercycle wait instead of inferring from the completed step", () => {
    const state = actor();
    enterIntercycleWait(state);

    expect(state.inFlightStep).toBeNull();
    expect(watchdogDiagnosticStep(state)).toBe("intercycle_wait");
  });

  test("names the transition before a step has been selected", () => {
    const state = actor();
    enterTransition(state);

    expect(state.inFlightStep).toBeNull();
    expect(watchdogDiagnosticStep(state)).toBe("transition");
  });

  test("keeps the active page_switch trace phase over the outer lifecycle", () => {
    const state = actor();
    state.pageSwitchTraces = [{ phase: "button_enabled", outcome: "started" }];
    beginInFlightStep(state, "page_switch");

    expect(watchdogDiagnosticStep(state)).toBe("page_switch.button_enabled");

    finishInFlightStep(state);
    expect(watchdogDiagnosticStep(state)).toBe("transition");
  });
});
