import { describe, expect, it } from "vitest";
import { canonicalizeStickyFontState } from "./stickyDerivedState";
import { STICKY_REFERENCE_FONT_SIZE, createStickyNote } from "./stickyNote";

const stickyScene = (fontSize: number) => {
  const note = createStickyNote(100, 100);
  note.boundElements = [{ id: "sticky-label", type: "text" }];
  return [
    note,
    {
      id: "sticky-label",
      type: "text",
      containerId: note.id,
      fontSize,
      version: 7,
      versionNonce: 11,
      updated: 13,
    },
    { id: "ordinary-label", type: "text", fontSize: 37, version: 2 },
  ];
};

describe("sticky derived-state boundary", () => {
  it("sends the reference coordinate instead of the locally derived font", () => {
    const scene = stickyScene(48.25);
    const canonical = canonicalizeStickyFontState(scene);
    expect(canonical[1]).toMatchObject({
      fontSize: STICKY_REFERENCE_FONT_SIZE,
      version: 7,
      versionNonce: 11,
      updated: 13,
    });
    expect(canonical[2]).toBe(scene[2]);
  });

  it("returns the same scene when no projection needs removing", () => {
    const scene = stickyScene(STICKY_REFERENCE_FONT_SIZE);
    expect(canonicalizeStickyFontState(scene)).toBe(scene);
  });
});
