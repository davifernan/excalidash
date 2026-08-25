/**
 * Making the text fit the note instead of the note fit the text.
 *
 * Excalidraw grows a container downwards when its label no longer fits. That is
 * right for a labelled box and wrong for a sticky note: a wall of notes only
 * reads as a wall while the notes stay the same size. Miro and tldraw both keep
 * the shape and shrink the writing, and that is what this does.
 *
 * The measuring is not ours. `restoreElements` with `refreshDimensions` runs
 * Excalidraw's own wrapping and text metrics over a throwaway copy of the note
 * and hands back what the label would become — so a size accepted here is a
 * size Excalidraw agrees with, to the pixel. Reimplementing the wrapping would
 * mean maintaining a second answer to the same question, and the two would
 * drift apart on the first CJK line break.
 *
 * ## Continuous, not stepped (NIL-580)
 *
 * This used to walk a fixed ladder of sizes (36, 28, 20, ...) top-down until one
 * fit, which is what made the shrink visibly jump between rungs instead of
 * flowing with each keystroke the way Miro's does. There is no ladder anymore:
 * `fitTextToNote` searches a continuous range and returns whatever real number
 * the content needs, clamped only by the note's own chosen size (the ceiling)
 * and `MIN_FONT_SIZE` (the floor, reasoning below) — nothing in between is
 * rounded to a step.
 *
 * The search still calls Excalidraw's real layout, because that is the only
 * accurate answer (see above) — but it no longer walks a fixed list of
 * candidates top-down. Between two word-wrap breakpoints (the font size range
 * where the text keeps the same number of lines), a label's height scales
 * linearly with font size — lines is constant, so height is just
 * `lines * lineHeightMultiplier * fontSize`. One real measurement's overflow
 * therefore gives an exact next guess in that regime —
 * `next = size * (available / measuredHeight)` — and when a rewrap does land
 * between the two sizes (the line count itself drops), the guess undershoots
 * rather than overshoots, so the following loop iteration corrects again from
 * a fresh real measurement.
 *
 * On measured cost, honestly: for this note's actual ceiling (20pt, the only
 * value `STICKY_BASE_FONT_SIZE` is — nothing in the product lets an author
 * choose a bigger one), the old ladder from 20 was already short (20, 16, 12,
 * 10, 8 — five candidates, not the seven `FONT_SIZE_LADDER` lists, since 36
 * and 28 sit above 20 and were never reachable). A call-count comparison
 * against the pre-NIL-580 ladder, same deterministic test fixture, same word
 * counts, found this search takes the *same* number of real-layout calls as
 * the old ladder at every length tested (1 for a short note, up to 5 for an
 * essay) — not fewer. The continuous result is the actual point of this cut;
 * it does not additionally buy a measurement-count win over what a five-rung
 * ladder already had. A ladder starting from a taller ceiling (the general
 * case this search also has to handle correctly, even though nothing in this
 * codebase creates one today) is where the fixed top-down walk would have
 * cost more and this does not — see this package's HANDOFF for the numbers.
 *
 * ## The floor (NIL-580's "Untergrenze" decision)
 *
 * `MIN_FONT_SIZE` is unreadable-and-below, not a stylistic choice — 8pt was
 * already the ladder's bottom rung under the same reasoning, so this cut keeps
 * the number rather than relitigating it. Below it, text stops shrinking and
 * the note keeps its floor-sized, wrapped-but-overflowing label rather than
 * hiding it: `StickyFit.fits` turns `false` so a caller can flag the note
 * (today: nothing further overflows visibly, since Excalidraw still clips the
 * label to the container) but the opening lines of whatever was pasted in stay
 * visible instead of the note going blank or growing without limit.
 *
 * ## Pure derivation, not a stored value (NIL-580's "zwei Bearbeiter" decision)
 *
 * The computed size is never written to `customData` — only the fixed,
 * author-chosen ceiling (`StickyData.fontSize`, set once at creation) lives
 * there, exactly as before this cut. The shrunk size this file returns lands
 * only on the bound text element's ordinary `fontSize` property, the same way
 * its wrapped `text`/`width`/`height` already did. That is deliberate: two
 * clients holding the same text and the same container dimensions run the same
 * pure function and always agree, byte for byte — there is no second value for
 * them to disagree about, and nothing to reconcile on reconnect beyond the
 * content itself. Storing the computed size instead (as its own customData
 * field, synced independently of the text it was derived from) would turn a
 * derivable fact into state — a field two concurrent editors could race on and
 * disagree about, for a number that is fully determined by data already on the
 * board.
 */
import { restore } from "../integrations/excalidraw/elements";

/** Excalidraw's own padding between a container and its label, per side. */
const BOUND_TEXT_PADDING = 5;

/**
 * The smallest the writing may shrink to. Below this the text is unreadable
 * regardless of the note's size, so the note keeps this size and overflows
 * rather than continuing to shrink. Unchanged from the old ladder's bottom
 * rung — see this file's header for the reasoning, carried over rather than
 * relitigated.
 */
export const MIN_FONT_SIZE = 8;

/**
 * Upper bound on real Excalidraw layout calls per `fitTextToNote`, so a very
 * long paste can't turn one keystroke into an unbounded measuring loop. The
 * linear correction below typically converges in 1-2 extra measurements past the
 * first (ceiling) attempt; this is a backstop, not the expected case.
 */
const MAX_FIT_ITERATIONS = 4;

export type StickyFit = {
  fontSize: number;
  /** The wrapped text, with the line breaks Excalidraw would have chosen. */
  text: string;
  width: number;
  height: number;
  x: number;
  y: number;
  /** False when even the smallest size overflows, so the caller can say so. */
  fits: boolean;
};

/**
 * Lay a label out at one font size without touching anything real.
 *
 * The copy is handed `text: originalText` on purpose. Excalidraw wraps whatever
 * is in `text`, and after an earlier fit that field already carries line breaks
 * — wrapping it again would keep those breaks and report a taller label than
 * the smaller font actually needs.
 */
function layoutAt(container: any, text: any, fontSize: number): StickyFit | null {
  const probe = {
    ...text,
    fontSize,
    text: text.originalText ?? text.text ?? "",
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
 * The largest continuous size, up to `baseFontSize`, whose label still fits
 * the note.
 *
 * Starts at the ceiling (the common case — most notes fit at their chosen
 * size, one measurement, done) and, on overflow, jumps toward a fitting size
 * using the measured overflow rather than stepping through fixed rungs: see
 * this file's header for the reasoning, and the loop body below for the
 * correction itself. Each guess is verified with a real Excalidraw
 * measurement, so the result is always a size Excalidraw actually agrees fits
 * — the formula only picks where to look next, it never stands in for the
 * measurement itself.
 */
export function fitTextToNote(container: any, text: any, baseFontSize: number): StickyFit | null {
  if (!container || !text) return null;

  const available = container.height - BOUND_TEXT_PADDING * 2;

  // The chosen size is always the ceiling, even below MIN_FONT_SIZE: an
  // author who explicitly picked something tiny is not overridden here.
  let size = baseFontSize;
  let best: StickyFit | null = null;
  let triedFloor = size <= MIN_FONT_SIZE;

  for (let i = 0; i < MAX_FIT_ITERATIONS; i += 1) {
    const candidate = layoutAt(container, text, size);
    if (!candidate) break;
    best = candidate;
    triedFloor = size <= MIN_FONT_SIZE;

    if (candidate.height <= available) return { ...candidate, fits: true };
    if (triedFloor) break;

    // Between two word-wrap breakpoints, the line count is fixed and height
    // scales linearly with font size (lines x lineHeightMultiplier x size) --
    // so `next = size * (available / height)` lands on the boundary exactly
    // when no rewrap happens in between. When a rewrap DOES land in between
    // (line count drops a step), this undercorrects rather than overshoots,
    // and the next loop iteration corrects again from the new real
    // measurement -- still always verified, never assumed.
    const next = size * (available / candidate.height);
    size = Math.max(MIN_FONT_SIZE, Math.min(next, size));
  }

  // The correction loop can overshoot the floor without ever measuring it
  // exactly (float rounding, or MAX_FIT_ITERATIONS running out first) — try it
  // once directly so "nothing fits" always means the floor itself was checked,
  // not a guess that happened to land just above it.
  if (!triedFloor) {
    const atFloor = layoutAt(container, text, MIN_FONT_SIZE);
    if (atFloor) best = atFloor;
  }

  // Nothing fits. Keeping the smallest beats refusing: a note somebody pasted
  // an essay into still shows its opening lines instead of turning blank.
  return best ? { ...best, fits: best.height <= available } : null;
}
