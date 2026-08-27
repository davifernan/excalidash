/**
 * Removes locally derived Sticky presentation from durable scene state.
 *
 * Excalidraw needs a `fontSize` on every text element to draw it, but for a
 * Sticky that number is fully determined by its text and container geometry.
 * Sending the local projection gives collaboration two apparent authors for
 * one derived value. At broadcast/save boundaries we therefore replace it
 * with the fixed measuring coordinate. The receiving client derives its own
 * visible value immediately; only text and note geometry are authoritative.
 */
import { STICKY_REFERENCE_FONT_SIZE, stickyDataOf } from "./stickyNote";
import { fitTextToNote } from "./stickyFit";

/**
 * Apply the pure Sticky presentation to an inbound scene before it is rendered.
 *
 * A collaborator can receive Excalidraw's temporary text-edit geometry. It is
 * useful to the person holding the editor, but it is not document state: the
 * Sticky's remembered dimensions are. Projecting only the font left that
 * temporary box and label position visible for one frame, after which local
 * upkeep corrected it as though the remote edit had already finished. That
 * made observers see the note jump on every edit update. Keep the entire
 * presentation derived here, without touching revisions or sending it back.
 */
export function deriveStickyFontState(
  elements: readonly any[],
  protectedIds: ReadonlySet<string> = new Set(),
): readonly any[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const projected = new Map<string, any>();

  for (const note of elements) {
    if (!note || note.isDeleted) continue;
    const data = stickyDataOf(note);
    if (!data) continue;

    if (protectedIds.has(note.id)) continue;
    const bound = note.boundElements?.find((element: any) => element?.type === "text");
    const label = bound && typeof bound.id === "string" ? byId.get(bound.id) : null;
    if (!label || label.isDeleted) continue;

    // A remote projection must not rewrite the note or label this editor is
    // currently holding. `heldElementIds()` includes the persisted label for
    // text editing, even though Excalidraw's draft has a temporary id.
    if (protectedIds.has(label.id)) continue;

    const renderedNote =
      note.width === data.width && note.height === data.height
        ? note
        : { ...note, width: data.width, height: data.height };
    if (renderedNote !== note) projected.set(note.id, renderedNote);

    const fit = fitTextToNote(renderedNote, label);
    if (!fit) continue;
    const renderedLabel = {
      ...label,
      text: fit.text,
      width: fit.width,
      height: fit.height,
      x: fit.x,
      y: fit.y,
      strokeColor: data.ink,
      fontSize: fit.fontSize,
    };
    if (
      renderedLabel.text !== label.text ||
      renderedLabel.width !== label.width ||
      renderedLabel.height !== label.height ||
      renderedLabel.x !== label.x ||
      renderedLabel.y !== label.y ||
      renderedLabel.strokeColor !== label.strokeColor ||
      renderedLabel.fontSize !== label.fontSize
    ) {
      projected.set(label.id, renderedLabel);
    }
  }

  return projected.size
    ? elements.map((element) => projected.get(element.id) ?? element)
    : elements;
}

export function canonicalizeStickyFontState(elements: readonly any[]): readonly any[] {
  if (!Array.isArray(elements) || elements.length === 0) return elements;

  const stickyLabelIds = new Set<string>();
  for (const element of elements) {
    if (!element || element.isDeleted || !stickyDataOf(element)) continue;
    const label = element.boundElements?.find((bound: any) => bound?.type === "text");
    if (typeof label?.id === "string") stickyLabelIds.add(label.id);
  }
  if (stickyLabelIds.size === 0) return elements;

  let changed = false;
  const canonical = elements.map((element) => {
    if (!stickyLabelIds.has(element?.id) || element.fontSize === STICKY_REFERENCE_FONT_SIZE) {
      return element;
    }
    changed = true;
    // This is serialization, not an edit: preserve version bookkeeping.
    return { ...element, fontSize: STICKY_REFERENCE_FONT_SIZE };
  });
  return changed ? canonical : elements;
}
