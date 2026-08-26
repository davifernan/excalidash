/**
 * Keeping notes note-shaped after somebody has typed in them.
 *
 * Excalidraw grows a container downwards when the label outgrows it. For a
 * labelled box that is right; for a note it is not, because a wall of notes
 * only reads as a wall while they are all the same size. So after each edit the
 * note is put back to the size it is meant to be and the writing is given
 * whatever size fits inside it.
 *
 * This runs on every scene change, which means it has to be still: given a note
 * it has already settled, it must return the very same objects, or each pass
 * would produce a new version, broadcast it, and the two clients would talk
 * past each other forever. `newElementWith` hands back the original element
 * when nothing actually differs, and that is what makes the loop terminate.
 */
import { withChanges } from "../integrations/excalidraw/elements";
import { deriveStickyFontSize, fitTextToNote } from "./stickyFit";
import { withExcalidashData } from "../integrations/excalidraw/customData";
import { stickyDataOf, type StickyData } from "./stickyNote";

/** The label bound to a container, if it has one. */
const labelOf = (container: any, byId: Map<string, any>): any | null => {
  const bound = container.boundElements?.find((b: any) => b?.type === "text");
  if (!bound) return null;
  const label = byId.get(bound.id);
  return label && !label.isDeleted ? label : null;
};

export type NormaliseOptions = {
  /**
   * Notes whose size the user has just finished changing by hand.
   *
   * A note that grew because its label did must be pulled back; a note somebody
   * dragged bigger must not. The two are indistinguishable from the elements
   * alone — only the editor knows a resize just ended — so the caller says.
   */
  resized?: ReadonlySet<string> | null;
  /**
   * Labels whose text editor is open right now.
   *
   * While somebody is typing, Excalidraw owns the label's wrapped text and its
   * box — it recomputes both on every keystroke — so only the font size is
   * ours to set. That is enough: the editor restyles itself whenever the scene
   * changes, so the writing shrinks as it is typed and the note never grows in
   * the first place. Writing the text or the box here as well would mean two
   * authors for the same field, one of them a frame behind.
   */
  editing?: ReadonlySet<string> | null;
};

/**
 * Local-only font projection for an in-progress native resize.
 *
 * The container's remembered dimensions must not be adopted until pointer-up,
 * and its geometry must not be rewritten while Excalidraw owns the gesture.
 * This therefore changes only the bound label's derived font and preserves all
 * revision fields.
 */
export function projectStickyFonts(
  elements: readonly any[],
  onlyContainerId?: string,
): any[] | null {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const projected = new Map<string, any>();
  for (const note of elements) {
    if (
      !note ||
      note.isDeleted ||
      !stickyDataOf(note) ||
      (onlyContainerId && note.id !== onlyContainerId)
    ) {
      continue;
    }
    const label = labelOf(note, byId);
    if (!label) continue;
    const fontSize = deriveStickyFontSize(note, label);
    if (fontSize === null || fontSize === label.fontSize) continue;
    projected.set(label.id, { ...label, fontSize });
  }
  return projected.size ? elements.map((element) => projected.get(element.id) ?? element) : null;
}

export const projectStickyResizeFont = (elements: readonly any[], resizingId: string) =>
  projectStickyFonts(elements, resizingId);

/**
 * The scene with every note put right, or null when nothing needed changing.
 *
 * Returning null rather than an equal array lets the caller skip the scene
 * update entirely. During a resize, `useStickyUpkeep` calls the narrower font
 * projection at most once per animation frame; this settled pass still runs
 * only when actual note state differs.
 */
export function normaliseStickyNotes(
  elements: readonly any[],
  options: NormaliseOptions = {},
): any[] | null {
  const byId = new Map<string, any>();
  for (const element of elements) byId.set(element.id, element);

  const replacements = new Map<string, any>();

  for (const element of elements) {
    if (element.isDeleted) continue;
    const data = stickyDataOf(element);
    if (!data) continue;

    const bound = element.boundElements?.find((b: any) => b?.type === "text");
    const beingTyped = bound ? (options.editing?.has(bound.id) ?? false) : false;

    let container = element;
    let next: StickyData = data;

    if (beingTyped) {
      // Leave the box alone; Excalidraw is resizing it per keystroke.
    } else if (options.resized?.has(element.id)) {
      // Adopt what the person chose. From here on this is the size to defend.
      if (container.width !== data.width || container.height !== data.height) {
        next = { ...data, width: container.width, height: container.height };
        container = withChanges(container, {
          customData: withExcalidashData(container, { sticky: next }),
        } as any);
      }
    } else if (container.height !== next.height || container.width !== next.width) {
      // Grown by its own label. Put it back.
      container = withChanges(container, {
        width: next.width,
        height: next.height,
      } as any);
    }

    const label = labelOf(container, byId);
    if (label) {
      // Measured against the size the note is meant to be, even mid-edit when
      // Excalidraw has temporarily made it taller.
      const target = beingTyped
        ? { ...container, width: next.width, height: next.height }
        : container;
      const fit = beingTyped ? null : fitTextToNote(target, label);
      const fontSize = beingTyped ? deriveStickyFontSize(target, label) : fit?.fontSize;
      if (fontSize !== null && fontSize !== undefined) {
        // The writing belongs to the note, the way it does on a real one:
        // Excalidraw would otherwise hand the label whichever colour the person
        // last drew a line in.
        const authoritative = beingTyped
          ? label
          : withChanges(label, {
              text: fit!.text,
              width: fit!.width,
              height: fit!.height,
              x: fit!.x,
              y: fit!.y,
              strokeColor: next.ink,
            } as any);
        // `fontSize` is local presentation, not an authored scene edit. A raw
        // projection is intentional here: bumping version/versionNonce would
        // make two clients repeatedly send each other a value both can derive.
        // Authoritative wrapping/colour changes above still use `withChanges`
        // and therefore retain Excalidraw's normal revision semantics.
        const fitted =
          authoritative.fontSize === fontSize ? authoritative : { ...authoritative, fontSize };
        if (fitted !== label) replacements.set(label.id, fitted);
      }
    }

    if (container !== element) replacements.set(element.id, container);
  }

  if (replacements.size === 0) return null;
  return elements.map((element) => replacements.get(element.id) ?? element);
}
