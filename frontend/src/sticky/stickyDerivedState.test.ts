import { beforeAll, describe, expect, it } from "vitest";
import { setCustomTextMetricsProvider } from "@excalidraw/excalidraw";
import { canonicalizeStickyFontState, deriveStickyFontState } from "./stickyDerivedState";
import { normaliseStickyNotes } from "./stickyNormalise";
import { STICKY_REFERENCE_FONT_SIZE, createStickyNote } from "./stickyNote";

beforeAll(() => {
  setCustomTextMetricsProvider({
    getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) / 2),
  });
});

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

  it("renders remote live-edit geometry from the sticky's remembered size", () => {
    const note = createStickyNote(100, 100);
    note.boundElements = [{ id: "sticky-label", type: "text" }];
    const remoteNote = { ...note, width: 200, height: 640 };
    const remoteLabel = {
      id: "sticky-label",
      type: "text",
      x: remoteNote.x + 5,
      y: remoteNote.y + 5,
      width: 190,
      height: 600,
      angle: 0,
      strokeColor: "#ff0000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      seed: 3,
      version: 7,
      versionNonce: 11,
      index: "a2",
      isDeleted: false,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: null,
      updated: 13,
      link: null,
      locked: false,
      text: "a long remote edit ".repeat(20),
      originalText: "a long remote edit ".repeat(20),
      fontSize: STICKY_REFERENCE_FONT_SIZE,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: note.id,
      lineHeight: 1.25,
      autoResize: true,
    };

    const rendered = deriveStickyFontState([remoteNote, remoteLabel]);
    expect(rendered[0]).toMatchObject({ width: 200, height: 200 });
    expect(rendered[1]).toMatchObject({
      version: remoteLabel.version,
      versionNonce: remoteLabel.versionNonce,
      updated: remoteLabel.updated,
      strokeColor: "#422006",
    });
    expect(rendered[1].height).toBeLessThan(remoteLabel.height);
    expect(normaliseStickyNotes(rendered)).toBeNull();
  });

  it("does not project a Sticky whose local label is being edited", () => {
    const note = createStickyNote(100, 100);
    const remoteNote = {
      ...note,
      width: 640,
      height: 480,
      boundElements: [{ id: "label", type: "text" }],
    };
    const remoteLabel = {
      id: "label",
      type: "text",
      containerId: remoteNote.id,
      text: "locally typing",
      originalText: "locally typing",
      width: 640,
      height: 480,
    };

    const rendered = deriveStickyFontState([remoteNote, remoteLabel], new Set([remoteLabel.id]));

    expect(rendered).toEqual([remoteNote, remoteLabel]);
  });
});
