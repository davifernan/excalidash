import { beforeAll, describe, expect, it } from "vitest";
import { setCustomTextMetricsProvider } from "@excalidraw/excalidraw";
import { MIN_FONT_SIZE, fitTextToNote } from "./stickyFit";
import { STICKY_REFERENCE_FONT_SIZE, createStickyNote } from "./stickyNote";

beforeAll(() => {
  setCustomTextMetricsProvider({
    getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) / 2),
  });
});

const label = (note: any, text: string, fontSize = STICKY_REFERENCE_FONT_SIZE) => ({
  id: "label",
  type: "text",
  x: note.x,
  y: note.y,
  width: 10,
  height: 10,
  angle: 0,
  strokeColor: "#000000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 1,
  versionNonce: 1,
  index: "a2",
  isDeleted: false,
  groupIds: [],
  frameId: null,
  roundness: null,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  text,
  originalText: text,
  fontSize,
  fontFamily: 5,
  textAlign: "center",
  verticalAlign: "middle",
  containerId: note.id,
  lineHeight: 1.25,
  autoResize: true,
});

const noteAt = (size: number) => {
  const note = createStickyNote(size / 2, size / 2);
  note.width = size;
  note.height = size;
  note.boundElements = [{ id: "label", type: "text" }];
  return note;
};

const textAt = (length: number) =>
  Array.from({ length }, (_, index) => (index % 6 === 5 ? " " : "x")).join("");

const sizeFor = (noteSize: number, length: number, currentFont?: number) => {
  const note = noteAt(noteSize);
  return fitTextToNote(note, label(note, textAt(length), currentFont))!.fontSize;
};

describe("fixed-reference ratio curve", () => {
  it("produces one smooth content curve at small, medium, and large note sizes", () => {
    const noteSizes = [120, 200, 360];
    const lengths = [3, 30, 300, 3000];
    const matrix = noteSizes.map((noteSize) => ({
      noteSize,
      sizes: lengths.map((length) => sizeFor(noteSize, length)),
    }));

    // Keep the ticket's required numeric matrix visible in test output.
    console.log(`NIL630_FONT_MATRIX=${JSON.stringify({ lengths, matrix })}`);

    for (const { sizes } of matrix) {
      expect(sizes[0]).toBeGreaterThan(sizes[1]);
      expect(sizes[1]).toBeGreaterThan(sizes[2]);
      expect(sizes[2]).toBeGreaterThanOrEqual(sizes[3]);
    }
    expect(matrix[2].sizes[0]).toBeGreaterThan(matrix[1].sizes[0]);
    expect(matrix[1].sizes[0]).toBeGreaterThan(matrix[0].sizes[0]);
  });

  it("changes continuously at the per-character boundary instead of jumping", () => {
    const samples = Array.from({ length: 180 }, (_, index) => sizeFor(200, index + 20));
    const at = samples.findIndex((value, index) => index > 0 && value < samples[index - 1]);
    expect(at).toBeGreaterThan(0);
    const delta = samples[at - 1] - samples[at];
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(1);
  });

  it("does not feed the currently rendered font back into the answer", () => {
    const fromTinyRender = sizeFor(200, 87, 8);
    const fromHugeRender = sizeFor(200, 87, 96);
    const fromItsOwnResult = sizeFor(200, 87, fromTinyRender);
    expect(fromTinyRender).toBe(fromHugeRender);
    expect(fromItsOwnResult).toBe(fromTinyRender);
  });

  it("is stable on both sides of a one-character shrink", () => {
    const before = sizeFor(200, 87);
    const after = sizeFor(200, 88);
    expect(after).toBeLessThan(before);
    for (let pass = 0; pass < 20; pass += 1) {
      expect(sizeFor(200, 87, pass % 2 ? 8 : 96)).toBe(before);
      expect(sizeFor(200, 88, pass % 2 ? 96 : 8)).toBe(after);
    }
  });
});

describe("fitting and floor behavior", () => {
  it("wraps at the note width and keeps the note geometry unchanged", () => {
    const note = noteAt(200);
    const fit = fitTextToNote(note, label(note, textAt(300)))!;
    expect(fit.width).toBeLessThanOrEqual(190);
    expect(fit.height).toBeLessThanOrEqual(190);
    expect(fit.text).toContain("\n");
    expect(note.width).toBe(200);
    expect(note.height).toBe(200);
  });

  it("uses the readable floor and reports overflow beyond it", () => {
    const note = noteAt(120);
    const fit = fitTextToNote(note, label(note, textAt(3000)))!;
    expect(fit.fontSize).toBe(MIN_FONT_SIZE);
    expect(fit.fits).toBe(false);
  });

  it("returns nothing instead of guessing without a container or label", () => {
    const note = noteAt(200);
    expect(fitTextToNote(note, null)).toBeNull();
    expect(fitTextToNote(null, label(note, "hi"))).toBeNull();
  });
});
