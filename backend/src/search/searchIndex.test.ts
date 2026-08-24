import { describe, expect, it } from "vitest";
import { computeSearchText, extractVisibleElementText } from "./searchIndex";

describe("extractVisibleElementText", () => {
  it("collects text from visible text elements only", () => {
    const elements = [
      { type: "text", text: "Ship the roadmap", isDeleted: false },
      { type: "rectangle" },
      { type: "text", text: "deleted note", isDeleted: true },
      { type: "text", text: "   ", isDeleted: false },
      { type: "text", isDeleted: false },
    ];
    expect(extractVisibleElementText(elements)).toEqual(["Ship the roadmap"]);
  });

  it("returns an empty array for non-array input", () => {
    expect(extractVisibleElementText(null)).toEqual([]);
    expect(extractVisibleElementText(undefined)).toEqual([]);
    expect(extractVisibleElementText("not an array")).toEqual([]);
  });
});

describe("computeSearchText", () => {
  it("lowercases and joins the board name with visible text content", () => {
    const elements = [{ type: "text", text: "Ship the ROADMAP", isDeleted: false }];
    expect(computeSearchText("Roadmap Q3", elements)).toBe("roadmap q3 \n ship the roadmap");
  });

  it("excludes a deleted element's text -- the red-probe case for NIL-363", () => {
    // Deleting the only text element must remove it from the search index in
    // the same request that deletes it, not on the next unrelated save.
    const withDeletedText = [{ type: "text", text: "secret plan", isDeleted: true }];
    expect(computeSearchText("Board", withDeletedText)).not.toContain("secret plan");
    expect(computeSearchText("Board", withDeletedText)).toBe("board");
  });

  it("caps pathologically large boards instead of growing the column unbounded", () => {
    const hugeText = "x".repeat(30_000);
    const elements = [{ type: "text", text: hugeText, isDeleted: false }];
    const result = computeSearchText("Board", elements);
    expect(result.length).toBeLessThanOrEqual(20_000);
  });
});
