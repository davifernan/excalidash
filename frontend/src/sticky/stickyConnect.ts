import { beginCanvasDrag } from "../integrations/excalidraw/domBridge";
import { createExcalidrawAdapter } from "../integrations/excalidraw";
import { toast } from "sonner";

/**
 * Dragging an arrow out of a note.
 *
 * Miro and tldraw both put small points on a note's edges: press one, drag to
 * another shape, and the two are joined. Excalidraw can already draw and bind
 * that arrow — what it has no affordance for is starting one from a shape, so
 * that is all this adds.
 *
 * The drag is not re-implemented. One synthetic pointer-down is handed to
 * Excalidraw's canvas with the arrow tool active, and from there Excalidraw
 * follows the pointer on `window` by itself, highlights what the arrow would
 * bind to, and binds both ends on release. Everything after the first event is
 * the editor's own behaviour, which is why the arrow behaves exactly like one
 * drawn by hand — because it is one.
 */

/** Where the points sit on a note's edge. */
export type HandleSide = "top" | "right" | "bottom" | "left";

export const HANDLE_SIDES: HandleSide[] = ["top", "right", "bottom", "left"];

/** The point on an element's edge, in scene coordinates. */
export function handlePoint(element: any, side: HandleSide): { x: number; y: number } {
  const midX = element.x + element.width / 2;
  const midY = element.y + element.height / 2;
  switch (side) {
    case "top":
      return { x: midX, y: element.y };
    case "bottom":
      return { x: midX, y: element.y + element.height };
    case "left":
      return { x: element.x, y: midY };
    default:
      return { x: element.x + element.width, y: midY };
  }
}

/**
 * Nudge the start point just outside the note.
 *
 * Starting exactly on the edge sometimes reads as a click inside the shape,
 * which drags the note instead of drawing from it. A few pixels clear of the
 * outline is unambiguous, and close enough that Excalidraw still binds the
 * arrow to the note it started next to.
 */
export const HANDLE_OUTSET = 6;

export function startPoint(element: any, side: HandleSide): { x: number; y: number } {
  const point = handlePoint(element, side);
  switch (side) {
    case "top":
      return { x: point.x, y: point.y - HANDLE_OUTSET };
    case "bottom":
      return { x: point.x, y: point.y + HANDLE_OUTSET };
    case "left":
      return { x: point.x - HANDLE_OUTSET, y: point.y };
    default:
      return { x: point.x + HANDLE_OUTSET, y: point.y };
  }
}

/** The topmost sticky note containing a scene point, if any. */
export function noteAt(
  elements: readonly any[],
  isNote: (element: any) => boolean,
  x: number,
  y: number,
): any | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (element.isDeleted || !isNote(element)) continue;
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
 * Hand the drag over to Excalidraw with the arrow tool in hand.
 *
 * The tool is set through React state, so the pointer-down has to wait a frame
 * for that to commit — otherwise the canvas would receive it while selection is
 * still active and drag the note instead. A frame is imperceptible to someone
 * holding the button down, and the arrow still starts at the point they pressed
 * rather than wherever the pointer has drifted to by then.
 */
export type DragOrigin = {
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
};

/**
 * Arm the arrow tool and start the drag the editor would have received.
 *
 * Both halves go through the layer now: the tool through the interaction
 * capability, the drag through the DOM bridge. The frame between them is the
 * bridge's business -- the tool is set through React state, and a pointer event
 * that lands before that commits is read as a selection drag instead.
 */
export function beginArrowDrag(api: any, container: HTMLElement | null, origin: DragOrigin): void {
  if (!api) return;
  const adapter = createExcalidrawAdapter({
    api: () => api,
    container: () => container,
    canEdit: () => true,
  });
  const { setActiveTool } = adapter.interaction;
  const armed = setActiveTool({ type: "builtin", name: "arrow" });
  if (!armed.ok) {
    toast.error("Couldn't start the arrow. Please try again.");
    return;
  }
  void beginCanvasDrag(container, origin);
}
