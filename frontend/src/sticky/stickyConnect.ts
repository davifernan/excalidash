import { beginCanvasDrag } from "../integrations/excalidraw/domBridge";
import { createBoundArrow, mergeArrowBinding } from "../integrations/excalidraw/boundArrow";
import type {
  InteractionCapability,
  SceneCapability,
  UiCapability,
} from "../integrations/excalidraw/capabilities";
import type { ElementId, ElementSummary, SceneOp } from "../integrations/excalidraw/types";
import { notify } from "../notifications";
import { STICKY_SIZE, createStickyNote, stickyColorById, stickyDataOf } from "./stickyNote";

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

/** Screen-space motion that distinguishes a click from an intentional drag. */
export const HANDLE_DRAG_THRESHOLD_PX = 6;

/**
 * Clear board-space between a parent and the child made from its handle.
 *
 * NIL-647: Davi found the default gap too tight ("haette gern mehr
 * Abstand"). This is the one place that distance is defined -- `previewChild`
 * (the ghost shown on hover) and `childPosition` (the slot the real child
 * lands in, including its own occupied-slot search) both derive from it, so
 * changing the number here is the whole fix; nothing else hardcodes a gap.
 */
export const CHILD_GAP = 96;

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
export function beginArrowDrag(
  interaction: Pick<InteractionCapability, "setActiveTool">,
  container: HTMLElement | null,
  origin: DragOrigin,
): Promise<void> {
  const { setActiveTool } = interaction;
  const armed = setActiveTool({ type: "builtin", name: "arrow" });
  if (!armed.ok) {
    notify("error", "Couldn't start the arrow. Please try again.");
    return Promise.resolve();
  }
  return beginCanvasDrag(container, origin).then(() => undefined);
}

const direction = (side: HandleSide): { x: number; y: number } => {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
};

const boxesOverlap = (a: ElementSummary, b: { x: number; y: number }): boolean =>
  a.x < b.x + STICKY_SIZE && a.x + a.width > b.x && a.y < b.y + STICKY_SIZE && a.y + a.height > b.y;

/**
 * First open child slot along the chosen axis. A busy slot advances by one
 * note plus the same gap, so repeated clicks produce a deterministic row or
 * column rather than a pile.
 */
export function childPosition(
  parent: ElementSummary,
  side: HandleSide,
  elements: readonly ElementSummary[],
): { x: number; y: number } {
  const step = STICKY_SIZE + CHILD_GAP;
  const vector = direction(side);
  const parentCenter = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };

  for (let slot = 1; ; slot += 1) {
    const center = {
      x: parentCenter.x + vector.x * step * slot,
      y: parentCenter.y + vector.y * step * slot,
    };
    const topLeft = { x: center.x - STICKY_SIZE / 2, y: center.y - STICKY_SIZE / 2 };
    const occupied = elements.some(
      (element) => !element.isDeleted && element.type !== "arrow" && boxesOverlap(element, topLeft),
    );
    if (!occupied) return center;
  }
}

const opposite = (side: HandleSide): HandleSide => {
  switch (side) {
    case "top":
      return "bottom";
    case "bottom":
      return "top";
    case "left":
      return "right";
    default:
      return "left";
  }
};

export type ChildPreview = {
  readonly child: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
};

export function previewChild(
  parent: ElementSummary,
  side: HandleSide,
  elements: readonly ElementSummary[],
): ChildPreview {
  const center = childPosition(parent, side, elements);
  const child = {
    x: center.x - STICKY_SIZE / 2,
    y: center.y - STICKY_SIZE / 2,
    width: STICKY_SIZE,
    height: STICKY_SIZE,
  };
  return {
    child,
    start: handlePoint(parent, side),
    end: handlePoint(child, opposite(side)),
  };
}

/** Create the child and its native bound arrow as one undoable scene update. */
export async function createConnectedChild(
  parent: ElementSummary,
  side: HandleSide,
  scene: Pick<SceneCapability, "summaries" | "applySettled">,
  ui: Pick<UiCapability, "beginTextEditing">,
  interaction: Pick<InteractionCapability, "readArrowStyle">,
): Promise<void> {
  const elements = scene.summaries();
  if (!elements.ok) return;

  const preview = previewChild(parent, side, elements.value);
  const sticky = stickyDataOf(parent);
  const child = {
    ...createStickyNote(
      preview.child.x + preview.child.width / 2,
      preview.child.y + preview.child.height / 2,
      stickyColorById(sticky?.color),
    ),
    frameId: parent.frameId,
  };
  const arrowStyle = interaction.readArrowStyle();
  if (!arrowStyle.ok) {
    notify("error", "Couldn't read the current arrow style. Please try again.");
    return;
  }
  const arrowId = crypto.randomUUID() as ElementId;
  const arrow = createBoundArrow(
    arrowId,
    parent,
    child,
    preview.start,
    preview.end,
    arrowStyle.value,
  );
  const arrowRef = mergeArrowBinding(null, arrowId);

  const applied = await scene.applySettled(
    [
      { kind: "insert", elements: [child] },
      { kind: "insert", elements: [arrow] },
      {
        kind: "patch",
        id: parent.id,
        changes: { boundElements: mergeArrowBinding(parent.boundElements, arrowId) },
      },
      { kind: "patch", id: child.id, changes: { boundElements: arrowRef } },
      { kind: "select", ids: [child.id] },
    ] as SceneOp[],
    // NIL-593 measured this exact insert+select shape: immediate capture makes
    // selection its own history entry; eventually keeps the gesture together.
    { capture: "eventually" },
  );
  if (!applied.ok) {
    notify("error", "Couldn't create the connected note. Please try again.");
    return;
  }
  // The scene has rendered after applySettled's first frame; bindings and the
  // eventual history checkpoint settle in the following one. Sending Enter
  // between those two lets label editing checkpoint a half-normalised edge.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await ui.beginTextEditing(child.id);
}
