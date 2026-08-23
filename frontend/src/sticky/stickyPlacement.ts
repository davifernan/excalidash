/**
 * Putting a note on the board and getting the cursor into it.
 *
 * Opening the label editor is the one step with no public API. Excalidraw
 * starts it from a real Enter key on a selected container and exposes no way to
 * ask for it directly, so the note is added, selected, and then sent an Enter.
 *
 * Whether that worked is deliberately not reported back. It used to be, and the
 * answer was read one frame too early — the editor opens through React state,
 * so a check made straight after the key nearly always said no even when it had
 * just said yes. If it ever genuinely does not open, the note is still there and
 * still selected, and Enter or a double-click does what it does on any shape.
 */
import { STICKY_BASE_FONT_SIZE, type StickyColor } from "./stickyNote";

import type {
  InteractionCapability,
  SceneCapability,
} from "../integrations/excalidraw/capabilities";
import { pressEnterToEditLabel } from "../integrations/excalidraw/domBridge";

/** Space between a note and the one spawned next to it. */
export const STICKY_GAP = 24;

/**
 * Ask the editor to open the selected note's label.
 *
 * Through the bridge, which waits for the editor to actually be editing rather
 * than assuming it is. `isEditing` is passed by the caller because only it knows
 * which note was just placed.
 */
function pressEnter(container: HTMLElement | null, isEditing: () => boolean): void {
  void pressEnterToEditLabel(container, isEditing);
}

/**
 * The frame a note is being dropped into, if any.
 *
 * Excalidraw does this for every element it creates itself: a shape drawn
 * inside a frame becomes part of it, and moving the frame takes the shape
 * along. A note placed by this code skipped that step, so it sat on a frame
 * without belonging to it and stayed behind whenever the frame was moved.
 *
 * Topmost first, because frames can be nested and the innermost one is the one
 * under the pointer.
 */
export function frameAt(elements: readonly any[], x: number, y: number): any | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element.isDeleted || element.type !== "frame") continue;
    if (
      x >= element.x &&
      x <= element.x + element.width &&
      y >= element.y &&
      y <= element.y + element.height
    ) {
      return element;
    }
  }
  return null;
}

/**
 * The board with the note in it, in the place that board keeps its members.
 *
 * A frame's children sit immediately before it in the element list; appending
 * elsewhere leaves a note that claims membership the ordering does not reflect.
 */
export function withNoteInserted(elements: readonly any[], note: any): any[] {
  if (!note.frameId) return [...elements, note];
  const at = elements.findIndex((element) => element.id === note.frameId);
  if (at < 0) return [...elements, note];
  return [...elements.slice(0, at), note, ...elements.slice(at)];
}

export function insertStickyNote(
  scene: Pick<SceneCapability, "summaries" | "apply">,
  containerEl: HTMLElement | null,
  note: any,
  color: StickyColor,
  interaction: Pick<InteractionCapability, "read">,
): void {
  // The capability arrives from the caller. Building one here would be a second
  // construction site for something the product is meant to have exactly once,
  // and it is how a consumer ends up choosing its own `canEdit`.
  const summaries = scene.summaries({ includeDeleted: true });
  if (!summaries.ok) return;

  const frame = frameAt(summaries.value, note.x + note.width / 2, note.y + note.height / 2);
  const placed = frame ? { ...note, frameId: frame.id } : note;

  // One write, not four. The note goes in immediately before its frame -- a
  // frame's children sit before it in the element order, and that rule lives in
  // the adapter now rather than here -- and the selection and the item defaults
  // the label will inherit travel with it. Splitting these would make three
  // renders out of one and let a remote change land in the middle.
  const inserted = scene.apply([
    {
      kind: "insert",
      elements: [placed],
      ...(frame ? { before: frame.id } : {}),
    },
    { kind: "select", ids: [placed.id] },
    {
      kind: "itemDefaults",
      fontSize: STICKY_BASE_FONT_SIZE,
      strokeColor: color.ink,
    },
  ]);
  // A refused write used to be impossible: the raw call either worked or threw.
  // The capability answers instead, and an unread answer means the note silently
  // never lands while the label editor is still asked to open on it.
  if (!inserted.ok) {
    console.error("[Sticky] Failed to insert note", inserted);
    return;
  }

  // The scene update is React state. The key has to arrive after it has been
  // committed, or Excalidraw finds nothing selected to type into -- and the
  // bridge then waits for the editor to really be editing rather than assuming
  // it, which is what NIL-308 asked for: a detection that survives the frame.
  requestAnimationFrame(() => {
    pressEnter(containerEl, () => {
      // Ask the capability, not the handle: the raw read was the last place in
      // this file that knew the editor exists.
      const state = interaction.read();
      return state.ok && state.value.editingTextContainerId === placed.id;
    });
  });
}
