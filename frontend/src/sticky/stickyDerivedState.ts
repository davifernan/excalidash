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
import { projectStickyFonts } from "./stickyNormalise";

/** Apply the pure projection to an inbound scene before it is rendered. */
export function deriveStickyFontState(elements: readonly any[]): readonly any[] {
  return projectStickyFonts(elements) ?? elements;
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
