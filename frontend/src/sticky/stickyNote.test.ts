import { describe, expect, it } from "vitest";
import {
  STICKY_COLORS,
  STICKY_SIZE,
  createStickyNote,
  isStickyNote,
  recolourSticky,
  stickyColorById,
  stickyDataOf,
} from "./stickyNote";

describe("making a note", () => {
  it("centres it on the point that was clicked", () => {
    const note = createStickyNote(500, 300);
    expect(note.x).toBe(500 - STICKY_SIZE / 2);
    expect(note.y).toBe(300 - STICKY_SIZE / 2);
    expect(note.width).toBe(STICKY_SIZE);
    expect(note.height).toBe(STICKY_SIZE);
  });

  it("comes out as a plain rectangle, so every other tool still understands it", () => {
    expect(createStickyNote(0, 0).type).toBe("rectangle");
  });

  it("looks like paper rather than a sketch", () => {
    const note = createStickyNote(0, 0);
    expect(note.fillStyle).toBe("solid");
    expect(note.roughness).toBe(0);
    expect(note.roundness).toBeNull();
    expect(note.backgroundColor).toBe(STICKY_COLORS[0].fill);
  });

  it("carries no label of its own", () => {
    // An empty bound text would be discarded by the next restore, taking any
    // note metadata stored on it along.
    expect(createStickyNote(0, 0).boundElements ?? []).toEqual([]);
  });

  it("remembers the size it is meant to be", () => {
    const data = stickyDataOf(createStickyNote(0, 0));
    expect(data).toMatchObject({ width: STICKY_SIZE, height: STICKY_SIZE });
  });

  it("gets a fresh id each time", () => {
    expect(createStickyNote(0, 0).id).not.toBe(createStickyNote(0, 0).id);
  });
});

describe("recognising a note", () => {
  it("knows one of ours", () => {
    expect(isStickyNote(createStickyNote(0, 0))).toBe(true);
  });

  it("does not claim an ordinary rectangle", () => {
    expect(isStickyNote({ type: "rectangle", customData: {} })).toBe(false);
    expect(isStickyNote({ type: "rectangle" })).toBe(false);
    expect(isStickyNote(null)).toBe(false);
  });

  it("ignores a record written by a version that is not this one", () => {
    const stranger = { customData: { excalidashSticky: { v: 99, color: "yellow" } } };
    expect(isStickyNote(stranger)).toBe(false);
  });

  it("leaves other customData alone", () => {
    const note = createStickyNote(0, 0);
    const withNeighbour = {
      ...note,
      customData: { ...note.customData, somethingElse: { keep: true } },
    };
    expect(recolourSticky(withNeighbour, STICKY_COLORS[2]).customData.somethingElse).toEqual({
      keep: true,
    });
  });
});

describe("colours", () => {
  it("falls back to the first colour for an id nobody knows", () => {
    expect(stickyColorById("chartreuse")).toBe(STICKY_COLORS[0]);
    expect(stickyColorById(undefined)).toBe(STICKY_COLORS[0]);
  });

  it("repaints the paper, the edge and the writing together", () => {
    const blue = STICKY_COLORS[2];
    const repainted = recolourSticky(createStickyNote(0, 0), blue);
    expect(repainted.backgroundColor).toBe(blue.fill);
    expect(repainted.strokeColor).toBe(blue.edge);
    expect(stickyDataOf(repainted)).toMatchObject({ color: blue.id, ink: blue.ink });
  });

  it("refuses to repaint something that is not a note", () => {
    const plain = { type: "rectangle", backgroundColor: "#fff" };
    expect(recolourSticky(plain, STICKY_COLORS[1])).toBe(plain);
  });

  it("keeps every colour dark enough to write on", () => {
    // Rough relative luminance: paper should be light, ink should not.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const color of STICKY_COLORS) {
      expect(luminance(color.fill)).toBeGreaterThan(0.6);
      expect(luminance(color.ink)).toBeLessThan(0.25);
    }
  });
});
