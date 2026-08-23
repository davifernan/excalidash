import { afterEach, describe, expect, it, vi } from "vitest";

import { fail } from "../errors";
import { onDiagnostic, reportFailure, resetDiagnostics } from "./diagnostics";

const failure = () =>
  fail("editor-changed", "ui.toolbarSlot", { detail: "toolbar missing", fallback: "main-menu" });

describe("the diagnostics sink", () => {
  afterEach(() => resetDiagnostics());

  it("says nothing when nobody is listening", () => {
    expect(() => reportFailure(failure(), "0.18.1")).not.toThrow();
  });

  it("hands a subscriber the seam, the code, the fallback and the version", () => {
    const heard = vi.fn();
    onDiagnostic(heard);

    reportFailure(failure(), "0.18.1");

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith({
      seam: "ui.toolbarSlot",
      code: "editor-changed",
      fallback: "main-menu",
      packageVersion: "0.18.1",
    });
  });

  it("does not pass on the detail, which is the only field that could carry content", () => {
    const heard = vi.fn();
    onDiagnostic(heard);

    reportFailure(
      fail("invalid-state", "scene.apply", { detail: "element 'Q3 revenue' is locked" }),
      "0.18.1",
    );

    expect(Object.keys(heard.mock.calls[0][0])).toEqual([
      "seam",
      "code",
      "fallback",
      "packageVersion",
    ]);
    expect(JSON.stringify(heard.mock.calls[0][0])).not.toContain("Q3 revenue");
  });

  it("keeps reporting to the others when one listener throws", () => {
    const second = vi.fn();
    onDiagnostic(() => {
      throw new Error("subscriber is broken");
    });
    onDiagnostic(second);

    expect(() => reportFailure(failure(), "0.18.1")).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops reporting once a subscriber unsubscribes", () => {
    const heard = vi.fn();
    const stop = onDiagnostic(heard);

    stop();
    reportFailure(failure(), "0.18.1");

    expect(heard).not.toHaveBeenCalled();
  });
});
