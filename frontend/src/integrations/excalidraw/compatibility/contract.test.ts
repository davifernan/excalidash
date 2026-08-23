import { describe, expect, it } from "vitest";

import { fail, isOk, ok, valueOr } from "../errors";
import type { CapabilityResult } from "../errors";

/**
 * Contract tests for the parts of the boundary that exist before any consumer
 * has been migrated.
 *
 * The types themselves are checked by the compiler; what cannot be checked
 * there is that the failure model behaves like a value. These assert the
 * things a consumer is entitled to rely on when it stops throwing and starts
 * reading a result.
 */
describe("the capability result", () => {
  it("narrows to its value without a cast", () => {
    const result: CapabilityResult<number> = ok(42);
    if (!isOk(result)) throw new Error("expected ok");
    // Reached only when the narrowing works; a cast here would hide a break.
    expect(result.value).toBe(42);
  });

  it("names the seam that failed, so a report can say where", () => {
    const result = fail("not-ready", "scene.readDocument");
    expect(result.ok).toBe(false);
    expect(result.seam).toBe("scene.readDocument");
  });

  it("carries a fallback only when one was offered", () => {
    expect(fail("unsupported", "ui.toolbarSlot", { fallback: "main-menu" }).fallback).toBe(
      "main-menu",
    );
    expect(fail("unsupported", "ui.toolbarSlot").fallback).toBeUndefined();
  });

  it("hands back the caller's default instead of throwing", () => {
    const failed: CapabilityResult<readonly string[]> = fail("not-ready", "scene.summaries");
    expect(valueOr(failed, [])).toEqual([]);
    expect(valueOr(ok(["a"]), [])).toEqual(["a"]);
  });

  it("never throws on a failure, which is the whole reason diagnostics exist", () => {
    const produce = (): CapabilityResult<string> => fail("editor-changed", "ui.beginTextEditing");
    expect(() => produce()).not.toThrow();
  });

  it("keeps the four codes the fallback model is written against", () => {
    const codes = (["unsupported", "not-ready", "invalid-state", "editor-changed"] as const).map(
      (code) => fail(code, "probe").code,
    );
    expect(codes).toEqual(["unsupported", "not-ready", "invalid-state", "editor-changed"]);
  });
});
