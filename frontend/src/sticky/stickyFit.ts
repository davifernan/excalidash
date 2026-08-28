/**
 * A sticky note's font size is a projection, not board state.
 *
 * Every pass starts from the unwrapped text and measures it at the one fixed
 * `STICKY_REFERENCE_FONT_SIZE`. The visible size is the reference size scaled
 * by the square root of `available note area / reference text area`: area
 * grows with the square of a uniform scale, hence the square root. This makes
 * sparse writing large, shrinks continuously as content is added, and makes a
 * geometrically larger note start with geometrically larger writing.
 *
 * Crucially, neither the label's current `fontSize` nor a previously rendered
 * measurement enters that calculation. Re-running it for the same text and
 * rectangle therefore returns the same number. There is no feedback loop in
 * which a smaller render appears to fit, grows, overflows, and shrinks again.
 * The final throwaway layouts below only verify and, around word-wrap changes,
 * conservatively cap that fixed-reference answer; they never use the live
 * element as a measuring source.
 *
 * The derived font is rendered on the local Excalidraw label, because canvas
 * text needs a font size. `canonicalizeStickyFontState` removes that projection
 * at persistence/collaboration boundaries, and `normaliseStickyNotes` applies
 * it without bumping the element's authoritative revision. Text and geometry
 * cross the wire; each client independently derives the same presentation.
 */
import { restore } from "../integrations/excalidraw/elements";
import { STICKY_REFERENCE_FONT_SIZE } from "./stickyNote";

/** Excalidraw's own padding between a container and its label, per side. */
export const BOUND_TEXT_PADDING = 5;

/**
 * Below 8 px the writing is not usable at ordinary canvas zoom. Once this
 * floor is reached, the font remains readable and excess text is clipped by
 * Excalidraw instead of becoming microscopic. This preserves NIL-580's
 * already-established lower bound and overflow behavior.
 */
export const MIN_FONT_SIZE = 8;

/** A one-line note may use at most 30% of the note's shorter inner edge. */
export const SPARSE_FONT_EDGE_RATIO = 0.3;

/** Leaves room for the unused tail of wrapped lines and real glyph bearings. */
const TEXT_AREA_UTILIZATION = 0.35;

/**
 * Word wrapping can change between the reference and derived sizes. A small,
 * bounded number of throwaway verification layouts corrects only overflow;
 * every invocation still starts from the fixed-reference ratio above.
 */
const MAX_OVERFLOW_CORRECTIONS = 3;

export type StickyFit = {
  fontSize: number;
  /** The wrapped text, with the line breaks Excalidraw would have chosen. */
  text: string;
  width: number;
  height: number;
  x: number;
  y: number;
  /** False when even the smallest readable size overflows. */
  fits: boolean;
};

/** Lay out unwrapped text on a throwaway copy; never touch the live scene. */
function layoutAt(container: any, text: any, fontSize: number): StickyFit | null {
  const probe = {
    ...text,
    fontSize,
    text: text.originalText ?? text.text ?? "",
    // `restoreElements` grows an autoResize label to fit its text but never
    // shrinks it below whatever width/height it is handed -- so feeding it
    // the label's own last-rendered box let a stale, larger-than-needed
    // render answer for the exact same content depending on what the label
    // happened to look like a moment before (measured: an empty label
    // returned fontSize 57 fresh and 55.53 once it had briefly been 23x71
    // wide, for byte-identical input). A 1px starting box is the smallest no
    // prior render can beat -- exactly 0 is dropped as an invalid element by
    // the restore step -- so every call grows up from (effectively) nothing
    // to the text's own natural size, and the answer depends only on `text`
    // and `fontSize`. The recentred x/y restore derives are anchored off this
    // same starting position, so it needs resetting for the same reason: left
    // at the label's last position, two back-to-back calls for the identical,
    // already-centred text measured the same box but centred it differently
    // (x drifted from -65.75 to -136.5 on a settled, unchanging note).
    width: 1,
    height: 1,
    x: container.x,
    y: container.y,
  };

  const restored = restore([container, probe], {
    repairBindings: true,
    refreshDimensions: true,
  }) as any[];
  const laidOut = restored.find((element) => element.id === text.id);
  if (!laidOut) return null;

  return {
    fontSize,
    text: laidOut.text,
    width: laidOut.width,
    height: laidOut.height,
    x: laidOut.x,
    y: laidOut.y,
    fits: true,
  };
}

/**
 * Measure the text without note-width wrapping, always at the reference font.
 * Width grows from the source text itself, so adding a character changes the
 * metric rather than suddenly adding a rendered line.
 */
function referenceLayout(container: any, text: any): StickyFit | null {
  const source = String(text.originalText ?? text.text ?? "");
  const lineCount = Math.max(1, source.split("\n").length);
  const measuringContainer = {
    ...container,
    width: Math.max(container.width, source.length * STICKY_REFERENCE_FONT_SIZE * 2 + 10),
    height: Math.max(container.height, lineCount * STICKY_REFERENCE_FONT_SIZE * 2 + 10),
  };
  return layoutAt(measuringContainer, text, STICKY_REFERENCE_FONT_SIZE);
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(value, maximum));

/**
 * Derive the font from content and note geometry alone.
 *
 * The input label's current `fontSize` is intentionally ignored. It may be a
 * stale remote projection, the native intermediate size during a resize, or
 * the result of the previous keystroke; none is source data.
 */
export function fitTextToNote(container: any, text: any): StickyFit | null {
  if (!container || !text) return null;

  const availableWidth = container.width - BOUND_TEXT_PADDING * 2;
  const availableHeight = container.height - BOUND_TEXT_PADDING * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  let size = deriveStickyFontSize(container, text);
  if (size === null) return null;
  let candidate: StickyFit | null = null;

  for (let i = 0; i <= MAX_OVERFLOW_CORRECTIONS; i += 1) {
    candidate = layoutAt(container, text, size);
    if (!candidate) return null;
    const overflow = Math.max(candidate.width / availableWidth, candidate.height / availableHeight);
    if (overflow <= 1) return { ...candidate, fits: true };
    if (size <= MIN_FONT_SIZE) break;
    size = Math.max(MIN_FONT_SIZE, size / overflow);
  }

  if (size > MIN_FONT_SIZE) {
    candidate = layoutAt(container, text, MIN_FONT_SIZE);
  }
  return candidate
    ? {
        ...candidate,
        fits: candidate.width <= availableWidth && candidate.height <= availableHeight,
      }
    : null;
}

/**
 * The fixed-reference ratio alone, for live typing and resize projections.
 * Excalidraw already lays the live label out on those paths, so doing a second
 * throwaway final layout per keystroke would add work without changing the
 * only value the caller uses.
 */
export function deriveStickyFontSize(container: any, text: any): number | null {
  if (!container || !text) return null;
  const availableWidth = container.width - BOUND_TEXT_PADDING * 2;
  const availableHeight = container.height - BOUND_TEXT_PADDING * 2;
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const reference = referenceLayout(container, text);
  if (!reference) return null;
  const availableArea = availableWidth * availableHeight * TEXT_AREA_UTILIZATION;
  const referenceArea = Math.max(1, reference.width * reference.height);
  const areaScale = Math.sqrt(availableArea / referenceArea);
  const geometryCeiling = Math.max(
    MIN_FONT_SIZE,
    Math.min(availableWidth, availableHeight) * SPARSE_FONT_EDGE_RATIO,
  );
  return clamp(STICKY_REFERENCE_FONT_SIZE * areaScale, MIN_FONT_SIZE, geometryCeiling);
}
