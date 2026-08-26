import { beforeAll, describe, expect, it } from "vitest";
import { setCustomTextMetricsProvider } from "@excalidraw/excalidraw";
import {
  normaliseStickyNotes,
  projectStickyFonts,
  projectStickyResizeFont,
} from "./stickyNormalise";
import {
  STICKY_REFERENCE_FONT_SIZE,
  STICKY_COLORS,
  STICKY_SIZE,
  createStickyNote,
  stickyDataOf,
} from "./stickyNote";

beforeAll(() => {
  setCustomTextMetricsProvider({
    getLineWidth: (text: string, font: string) => text.length * (parseFloat(font) / 2),
  });
});

const labelFor = (note: any, text: string, over: Record<string, any> = {}) => ({
  id: `${note.id}-label`,
  type: "text",
  x: note.x + 5,
  y: note.y + 5,
  width: 100,
  height: 25,
  angle: 0,
  strokeColor: "#ff0000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  seed: 3,
  version: 4,
  versionNonce: 5,
  index: "a2",
  isDeleted: false,
  groupIds: [],
  frameId: null,
  roundness: null,
  boundElements: null,
  updated: 10,
  link: null,
  locked: false,
  text,
  originalText: text,
  fontSize: STICKY_REFERENCE_FONT_SIZE,
  fontFamily: 5,
  textAlign: "center",
  verticalAlign: "middle",
  containerId: note.id,
  lineHeight: 1.25,
  autoResize: true,
  ...over,
});

const scene = (text: string, noteOver: Record<string, any> = {}) => {
  const note = { ...createStickyNote(0, 0), ...noteOver };
  note.boundElements = [{ id: `${note.id}-label`, type: "text" }];
  return [note, labelFor(note, text)];
};

const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");

describe("putting a note back to size", () => {
  it("undoes the growth Excalidraw applied to fit the label", () => {
    const [note, label] = scene(long, { height: 640 });
    const out = normaliseStickyNotes([note, label])!;
    expect(out[0].height).toBe(STICKY_SIZE);
    expect(out[0].width).toBe(STICKY_SIZE);
  });

  it("shrinks the writing instead", () => {
    const [note, label] = scene(long, { height: 640 });
    const out = normaliseStickyNotes([note, label])!;
    expect(out[1].fontSize).toBeLessThan(STICKY_REFERENCE_FONT_SIZE);
  });

  it("gives the writing the note's own colour", () => {
    const [note, label] = scene("Hello");
    const out = normaliseStickyNotes([note, label])!;
    expect(out[1].strokeColor).toBe(STICKY_COLORS[0].ink);
  });

  it("bumps the revision so the change reaches the other screen", () => {
    const [note, label] = scene("Hello");
    const out = normaliseStickyNotes([note, label])!;
    expect(out[1].version).toBeGreaterThan(label.version);
  });
});

describe("staying still once everything is right", () => {
  it("reports no change on a note that is already settled", () => {
    const [note, label] = scene("Hello");
    const once = normaliseStickyNotes([note, label])!;
    expect(normaliseStickyNotes(once)).toBeNull();
  });

  it("settles a grown note in a single further pass", () => {
    const [note, label] = scene(long, { height: 640 });
    const once = normaliseStickyNotes([note, label])!;
    expect(normaliseStickyNotes(once)).toBeNull();
  });

  it("hands back the very same objects it did not touch", () => {
    const [note, label] = scene("Hello");
    const other = { id: "other", type: "ellipse", isDeleted: false };
    const out = normaliseStickyNotes([note, label, other])!;
    expect(out[2]).toBe(other);
  });

  it("ignores everything that is not a note", () => {
    const plain = { id: "r", type: "rectangle", width: 10, height: 10, isDeleted: false };
    expect(normaliseStickyNotes([plain])).toBeNull();
  });

  it("leaves a note nobody has written in alone", () => {
    const note = createStickyNote(0, 0);
    expect(normaliseStickyNotes([note])).toBeNull();
  });
});

describe("a note somebody resized by hand", () => {
  it("ignores transient label-driven growth outside the live-resize path", () => {
    const [note, label] = scene(long, { width: 640, height: 640 });
    const projected = projectStickyFonts([note, label])!;
    const liveResize = projectStickyResizeFont([note, label], note.id)!;

    expect(projected[1].fontSize).toBeLessThan(liveResize[1].fontSize);
    expect(projected[1].fontSize).toBeLessThan(STICKY_REFERENCE_FONT_SIZE);
  });

  it("projects the live geometry without changing container state or revision", () => {
    const [note, label] = scene("tiny", { width: 260, height: 260 });
    const out = projectStickyResizeFont([note, label], note.id)!;
    expect(out[0]).toBe(note);
    expect(out[1].fontSize).toBeGreaterThan(label.fontSize);
    expect(out[1]).toMatchObject({
      version: label.version,
      versionNonce: label.versionNonce,
      updated: label.updated,
    });
  });

  it("keeps the new size and remembers it", () => {
    const [note, label] = scene("Hello", { width: 400, height: 320 });
    const out = normaliseStickyNotes([note, label], { resized: new Set([note.id]) })!;
    expect(out[0].width).toBe(400);
    expect(out[0].height).toBe(320);
    expect(stickyDataOf(out[0])).toMatchObject({ width: 400, height: 320 });
  });

  it("does not snap it back on the pass after that", () => {
    const [note, label] = scene("Hello", { width: 400, height: 320 });
    const adopted = normaliseStickyNotes([note, label], { resized: new Set([note.id]) })!;
    const after = normaliseStickyNotes(adopted);
    expect(after?.[0].height ?? 320).toBe(320);
  });

  it("lets the writing use the extra room", () => {
    const tight = scene(long, { height: 640 });
    const roomy = scene(long, { width: 600, height: 600 });
    const small = normaliseStickyNotes(tight)!;
    const large = normaliseStickyNotes(roomy, { resized: new Set([roomy[0].id]) })!;
    expect(large[1].fontSize).toBeGreaterThan(small[1].fontSize);
  });

  it("still pulls back a note that grew on its own", () => {
    const [note, label] = scene(long, { height: 640 });
    const out = normaliseStickyNotes([note, label], { resized: new Set(["someone-else"]) })!;
    expect(out[0].height).toBe(STICKY_SIZE);
  });
});

describe("a label that went away", () => {
  it("ignores a deleted label rather than measuring it", () => {
    const [note, label] = scene("Hello");
    const out = normaliseStickyNotes([note, { ...label, isDeleted: true }]);
    expect(out).toBeNull();
  });

  it("survives a note pointing at a label that is not in the scene", () => {
    const note = createStickyNote(0, 0);
    note.boundElements = [{ id: "ghost", type: "text" }];
    expect(() => normaliseStickyNotes([note])).not.toThrow();
  });
});

describe("while somebody is typing", () => {
  const editingLabel = (note: any) => new Set([`${note.id}-label`]);

  it("shrinks the writing as it is typed", () => {
    const [note, label] = scene(long);
    const out = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    expect(out[1].fontSize).toBeLessThan(STICKY_REFERENCE_FONT_SIZE);
  });

  it("projects the derived font without authoring a new scene revision", () => {
    const [note, label] = scene("tiny");
    const out = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    expect(out[1].fontSize).toBeGreaterThan(label.fontSize);
    expect(out[1]).toMatchObject({
      version: label.version,
      versionNonce: label.versionNonce,
      updated: label.updated,
    });
  });

  it("leaves the wrapped text to Excalidraw, which owns it mid-edit", () => {
    const [note, label] = scene(long);
    const out = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    expect(out[1].text).toBe(label.text);
    expect(out[1].width).toBe(label.width);
    expect(out[1].height).toBe(label.height);
  });

  it("does not fight the box Excalidraw is resizing per keystroke", () => {
    const [note, label] = scene(long, { height: 640 });
    const out = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    expect(out[0].height).toBe(640);
  });

  it("measures against the size the note is meant to be, not the grown one", () => {
    // A note stretched to 640 while typing must not be taken as room to write
    // in, or the font would stay large and snap down at the end.
    const [note, label] = scene(long, { height: 640 });
    const typing = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    const settled = normaliseStickyNotes([note, label])!;
    expect(typing[1].fontSize).toBe(settled[1].fontSize);
  });

  it("settles without a jump once the editor closes", () => {
    const [note, label] = scene(long, { height: 640 });
    const typing = normaliseStickyNotes([note, label], { editing: editingLabel(note) })!;
    const settled = normaliseStickyNotes(typing)!;
    expect(settled[1].fontSize).toBe(typing[1].fontSize);
    expect(settled[0].height).toBe(STICKY_SIZE);
  });

  it("stays still on a note already at the right size", () => {
    const [note, label] = scene("Hello");
    const settled = normaliseStickyNotes([note, label])!;
    expect(normaliseStickyNotes(settled, { editing: editingLabel(note) })).toBeNull();
  });
});
