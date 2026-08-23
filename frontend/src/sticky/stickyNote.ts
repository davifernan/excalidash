/**
 * What a sticky note is made of.
 *
 * Not a new kind of element. A note is an ordinary Excalidraw rectangle with
 * ordinary bound text, styled to read as paper and marked in `customData` so
 * the rest of the editor can recognise it later. Inventing an element type
 * would mean forking Excalidraw and carrying that fork forever; this way a note
 * exports, prints, gets selected, grouped and searched like everything else on
 * the board, and an older client that knows nothing about notes still shows a
 * yellow box with writing in it rather than nothing at all.
 *
 * The rectangle carries the marker, never the label. Excalidraw discards a
 * bound text element that has no text in it, so anything stored on the label
 * would disappear the first time somebody emptied a note.
 */
import { buildElements } from "../integrations/excalidraw/elements";

import {
  readSticky,
  withExcalidashData,
  type StickyRecord,
} from "../integrations/excalidraw/customData";

/** Miro's key for the same tool, and free in Excalidraw's own bindings. */
export const STICKY_SHORTCUT = "n";

export const STICKY_SIZE = 200;
export const STICKY_BASE_FONT_SIZE = 20;

export type StickyColor = {
  id: string;
  label: string;
  /** The paper. */
  fill: string;
  /** A shade darker, so a note on a white board still has an edge. */
  edge: string;
  /** The writing, dark enough to read on the paper. */
  ink: string;
};

/**
 * Six colours, not a colour picker.
 *
 * Sticky notes carry meaning through colour — this column is blockers, that one
 * is done — and that only works while everyone reaches for the same six. A free
 * picker turns a board into forty shades nobody can group by.
 */
export const STICKY_COLORS: StickyColor[] = [
  { id: "yellow", label: "Yellow", fill: "#fde68a", edge: "#f2d374", ink: "#422006" },
  { id: "green", label: "Green", fill: "#bbf7d0", edge: "#92e5b0", ink: "#052e16" },
  { id: "blue", label: "Blue", fill: "#bfdbfe", edge: "#93c5fd", ink: "#172554" },
  { id: "pink", label: "Pink", fill: "#fbcfe8", edge: "#f9a8d4", ink: "#4a044e" },
  { id: "orange", label: "Orange", fill: "#fed7aa", edge: "#fdba74", ink: "#431407" },
  { id: "grey", label: "Grey", fill: "#e5e7eb", edge: "#d1d5db", ink: "#111827" },
];

export const DEFAULT_STICKY_COLOR = STICKY_COLORS[0];

export const stickyColorById = (id: string | undefined): StickyColor =>
  STICKY_COLORS.find((color) => color.id === id) ?? DEFAULT_STICKY_COLOR;

/**
 * What a note remembers about itself.
 *
 * The shape belongs to the customData schema, not to this file: it is stored
 * on the element and read back by anything that meets one.
 */
export type StickyData = StickyRecord;

export const stickyDataOf = (element: any): StickyData | null => readSticky(element);

export const isStickyNote = (element: any): boolean => stickyDataOf(element) !== null;

/**
 * A note, centred on the point somebody clicked.
 *
 * Deliberately without its label. Excalidraw creates the bound text itself the
 * moment typing starts, with the container's own centring — and an empty one
 * created ahead of time would be thrown away by the next restore.
 */
export function createStickyNote(
  x: number,
  y: number,
  color: StickyColor = DEFAULT_STICKY_COLOR,
): any {
  const [rectangle] = buildElements(
    [
      {
        type: "rectangle",
        x: x - STICKY_SIZE / 2,
        y: y - STICKY_SIZE / 2,
        width: STICKY_SIZE,
        height: STICKY_SIZE,
        backgroundColor: color.fill,
        strokeColor: color.edge,
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        // Flat, not sketched. The hand-drawn edge is what stops a rectangle
        // reading as paper, and square corners are what make it read as a note
        // rather than a rounded card.
        roughness: 0,
        roundness: null,
        opacity: 100,
      },
    ] as any,
    { regenerateIds: true },
  ) as any[];

  const data: StickyData = {
    color: color.id,
    ink: color.ink,
    width: STICKY_SIZE,
    height: STICKY_SIZE,
    fontSize: STICKY_BASE_FONT_SIZE,
  };

  return {
    ...rectangle,
    // Excalidraw orders the board by a fractional index, and hands this one
    // "a0" — the lowest there is — because it was indexed inside a one-element
    // array of its own. The editor repairs that on the way in, so nothing
    // visibly goes wrong today, but claiming to be the bottom of a board this
    // element has never been part of is a statement that happens to be
    // harmless rather than one that is true. Null is what the schema means by
    // "not placed yet", and it leaves the ordering to the only code that knows
    // the board.
    index: null,
    customData: withExcalidashData(rectangle, { sticky: data }),
  };
}

/** The same note in a different colour, label included. */
export function recolourSticky(element: any, color: StickyColor): any {
  const data = stickyDataOf(element);
  if (!data) return element;
  return {
    ...element,
    backgroundColor: color.fill,
    strokeColor: color.edge,
    customData: withExcalidashData(element, {
      sticky: { ...data, color: color.id, ink: color.ink },
    }),
  };
}
