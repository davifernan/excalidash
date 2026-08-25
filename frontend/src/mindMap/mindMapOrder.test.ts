import { describe, expect, it } from "vitest";
import { orderKeyAfter } from "./mindMapOrder";

describe("orderKeyAfter", () => {
  it("returns a fixed first key when there are no siblings yet", () => {
    expect(orderKeyAfter([])).toBe("m");
  });

  it("returns a key that sorts after a single existing sibling", () => {
    const first = orderKeyAfter([]);
    const second = orderKeyAfter([first]);
    expect(second > first).toBe(true);
  });

  it("keeps increasing across many appends without ever repeating or going backwards", () => {
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const next = orderKeyAfter(keys);
      expect(keys.every((existing) => next > existing)).toBe(true);
      keys.push(next);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only looks at the greatest existing key, regardless of input order", () => {
    const a = orderKeyAfter([]);
    const b = orderKeyAfter([a]);
    const c = orderKeyAfter([a, b]);
    expect(orderKeyAfter([b, a])).toBe(c);
    expect(orderKeyAfter([a, b])).toBe(c);
  });

  /**
   * Counter-test (NIL-570 evidence requirement): break the enforcement, not a
   * constant, by copying the file and reverting the alphabet-bump branch to
   * something that can regress -- appending unconditionally without bumping.
   * That variant still "works" for a few steps but repeats once the alphabet
   * character is not exercised; the point is that THIS test fails against
   * that broken variant, proving it exercises the bump path and not just the
   * append fallback.
   */
  it("bumps the trailing character instead of only growing the string (regression guard)", () => {
    const buggyAppendOnly = (existing: readonly string[]): string => {
      const greatest = existing.reduce<string | null>(
        (max, key) => (max === null || key > max ? key : max),
        null,
      );
      return greatest === null ? "m" : greatest + "m";
    };
    const good: string[] = [];
    const buggy: string[] = [];
    for (let i = 0; i < 5; i++) {
      good.push(orderKeyAfter(good));
      buggy.push(buggyAppendOnly(buggy));
    }
    // The always-append variant keeps growing ("m", "mm", "mmm", ...); the
    // real implementation bumps in place at least once in five steps.
    expect(good.some((key, index) => index > 0 && key.length === good[index - 1].length)).toBe(
      true,
    );
    expect(buggy.every((key, index) => index === 0 || key.length > buggy[index - 1].length)).toBe(
      true,
    );
  });
});
