/**
 * The four points on a note's edges.
 *
 * They appear on the note under the pointer and on the one that is selected,
 * which is how Miro and tldraw do it: near enough to reach without aiming, gone
 * as soon as attention moves elsewhere. Pressing one starts an arrow — see
 * stickyConnect for why that is Excalidraw's own drag rather than a copy of it.
 *
 * The canvas is told about here through `excalidrawAPI.onChange` rather than
 * through a prop from the editor. Lifting that signal into the page's state
 * would make every scene change re-render Excalidraw, which fires another
 * change — a loop that ends with React refusing to render anything at all.
 * Subscribing keeps the churn inside this component, and the layout is compared
 * before it is stored so a change that moves nothing costs nothing.
 */
import React, { useEffect, useRef, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  UiCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import type {
  ElementId,
  ElementSummary,
  InteractionState,
  SelectionState,
} from "../integrations/excalidraw/types";
import { projectPoint } from "../integrations/excalidraw/viewport";
import { stacking } from "../integrations/excalidraw/stacking";
import { dispatchCanvasDragPointer } from "../integrations/excalidraw/domBridge";
import {
  HANDLE_SIDES,
  HANDLE_DRAG_THRESHOLD_PX,
  beginArrowDrag,
  createConnectedChild,
  handlePoint,
  noteAt,
  previewChild,
  startPoint,
  type HandleSide,
} from "./stickyConnect";
import { isStickyNote } from "./stickyNote";

const DOT = 9;

type Dot = { side: HandleSide; x: number; y: number };
type Layout = { noteId: ElementId; dots: Dot[] };

type Props = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  isDragging: () => boolean;
  interaction: Pick<InteractionCapability, "read" | "setActiveTool" | "setActiveToolSettled">;
  scene: Pick<SceneCapability, "subscribe" | "summaries" | "summaryById" | "applySettled">;
  selection: Pick<SelectionCapability, "read">;
  ui: Pick<UiCapability, "beginTextEditing">;
  viewport: Pick<ViewportCapability, "read" | "toScene">;
};

/** The single selected note, if exactly one note is selected. */
function selectedNote(
  elements: readonly ElementSummary[],
  selection: SelectionState,
): ElementSummary | null {
  if (selection.selectedIds.length !== 1) return null;
  const found = elements.find((element) => element.id === selection.selectedIds[0]);
  return found && isStickyNote(found) ? found : null;
}

/** Nothing to show while another tool is in hand or a gesture is underway. */
function isBusy(interaction: InteractionState, dragging: boolean): boolean {
  return (
    interaction.activeTool.type !== "selection" ||
    !!interaction.editingTextElementId ||
    dragging ||
    !!interaction.resizingElementId ||
    !!interaction.creatingElementId
  );
}

function layoutFor(
  capabilities: Pick<Props, "interaction" | "scene" | "selection" | "viewport">,
  dragging: boolean,
  hoveredId: string | null,
): Layout | null {
  const { interaction, scene, selection, viewport } = capabilities;
  const state = interaction.read();
  if (!state.ok || isBusy(state.value, dragging)) return null;

  const elements = scene.summaries();
  const selected = selection.read();
  const viewportState = viewport.read();
  if (!elements.ok || !selected.ok || !viewportState.ok) return null;

  const note =
    elements.value.find((element) => element.id === hoveredId && isStickyNote(element)) ??
    selectedNote(elements.value, selected.value);
  // A rotated note would need rotated points; nobody rotates a sticky note, and
  // guessing wrong would put the dots somewhere they do not belong.
  if (!note || note.angle) return null;

  return {
    noteId: note.id,
    dots: HANDLE_SIDES.map((side) => {
      const scene = handlePoint(note, side);
      const { x, y } = projectPoint({ x: scene.x, y: scene.y }, viewportState.value);
      return { side, x, y };
    }),
  };
}

const signature = (layout: Layout | null) =>
  layout
    ? `${layout.noteId}:${layout.dots.map((d) => `${Math.round(d.x)},${Math.round(d.y)}`).join("|")}`
    : "";

export const StickyHandles: React.FC<Props> = ({
  containerRef,
  canEdit,
  isDragging,
  interaction,
  scene,
  selection,
  ui,
  viewport,
}) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [previewSide, setPreviewSide] = useState<HandleSide | null>(null);
  const handleGestureActive = useRef(false);
  const activeGestures = useRef(new Set<string>());
  const creatingChildren = useRef(new Set<string>());

  // Excalidraw does not say what the pointer is over, so the note under it is
  // worked out here. Sticky notes are plain axis-aligned boxes, which makes
  // that a comparison rather than a hit test.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canEdit) return;

    const onMove = (event: PointerEvent) => {
      const state = interaction.read();
      if (!state.ok || state.value.activeTool.type !== "selection") {
        setHoveredId(null);
        return;
      }
      const point = viewport.toScene({ x: event.clientX, y: event.clientY });
      const elements = scene.summaries();
      if (!point.ok || !elements.ok) {
        setHoveredId(null);
        return;
      }
      const note = noteAt(elements.value, isStickyNote, point.value.x, point.value.y);
      setHoveredId((current) => {
        const next = note?.id ?? null;
        return current === next ? current : next;
      });
    };
    const onLeave = () => setHoveredId(null);

    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);
    return () => {
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
    };
  }, [canEdit, containerRef, interaction, scene, viewport]);

  useEffect(() => {
    if (!canEdit) return;
    const refresh = () =>
      setLayout((current) => {
        if (handleGestureActive.current) return current;
        const next = layoutFor(
          { interaction, scene, selection, viewport },
          isDragging(),
          hoveredId,
        );
        return signature(current) === signature(next) ? current : next;
      });

    refresh();
    return scene.subscribe(refresh);
  }, [canEdit, hoveredId, interaction, isDragging, scene, selection, viewport]);

  useEffect(() => {
    if (!layout) setPreviewSide(null);
  }, [layout]);

  if (!canEdit || !layout) return null;

  const preview = (() => {
    if (!previewSide) return null;
    const parent = scene.summaryById(layout.noteId);
    const elements = scene.summaries();
    const viewportState = viewport.read();
    if (!parent.ok || !parent.value || !elements.ok || !viewportState.ok) return null;
    const candidate = previewChild(parent.value, previewSide, elements.value);
    const start = projectPoint(candidate.start, viewportState.value);
    const end = projectPoint(candidate.end, viewportState.value);
    const topLeft = projectPoint(
      { x: candidate.child.x, y: candidate.child.y },
      viewportState.value,
    );
    const bottomRight = projectPoint(
      {
        x: candidate.child.x + candidate.child.width,
        y: candidate.child.y + candidate.child.height,
      },
      viewportState.value,
    );
    return { start, end, topLeft, bottomRight };
  })();

  return (
    <>
      {preview && (
        <svg
          data-testid="sticky-child-preview"
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            overflow: "visible",
            pointerEvents: "none",
            zIndex: stacking.elementOverlay,
          }}
        >
          <defs>
            <marker
              id="sticky-child-preview-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#6965db" />
            </marker>
          </defs>
          <rect
            x={preview.topLeft.x}
            y={preview.topLeft.y}
            width={preview.bottomRight.x - preview.topLeft.x}
            height={preview.bottomRight.y - preview.topLeft.y}
            fill="#6965db"
            fillOpacity="0.08"
            stroke="#6965db"
            strokeOpacity="0.45"
            strokeDasharray="5 4"
          />
          <line
            x1={preview.start.x}
            y1={preview.start.y}
            x2={preview.end.x}
            y2={preview.end.y}
            stroke="#6965db"
            strokeWidth="2"
            strokeOpacity="0.55"
            markerEnd="url(#sticky-child-preview-arrow)"
          />
        </svg>
      )}
      {layout.dots.map((dot) => (
        <button
          key={dot.side}
          type="button"
          aria-label={`Draw an arrow from this note (${dot.side})`}
          data-testid={`sticky-handle-${dot.side}`}
          onPointerEnter={() => setPreviewSide(dot.side)}
          onPointerLeave={() =>
            setPreviewSide((current) => (current === dot.side ? null : current))
          }
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const note = scene.summaryById(layout.noteId);
            const viewportState = viewport.read();
            const container = containerRef.current;
            if (!note.ok || !note.value || !viewportState.ok || !container) return;
            const parent = note.value;
            const gestureKey = `${parent.id}:${dot.side}`;
            if (activeGestures.current.has(gestureKey)) return;
            activeGestures.current.add(gestureKey);
            handleGestureActive.current = true;
            // Preparing the tool does not start a canvas gesture or create a
            // history entry. It only lets Excalidraw commit the tool before a
            // later threshold-crossing move asks the DOM bridge to pointerdown.
            interaction.setActiveTool({ type: "builtin", name: "arrow" });

            const from = startPoint(parent, dot.side);
            const point = projectPoint({ x: from.x, y: from.y }, viewportState.value);
            const rect = container.getBoundingClientRect();
            const origin = {
              clientX: rect.left + point.x,
              clientY: rect.top + point.y,
              pointerId: event.pointerId,
              pointerType: event.pointerType,
            };
            const pointerId = event.pointerId;
            const pressedAt = { x: event.clientX, y: event.clientY };
            let armingDrag = false;
            let dragReady = false;
            let releasedWhileArming = false;
            let latest = { x: event.clientX, y: event.clientY };

            const cleanup = () => {
              handleGestureActive.current = false;
              activeGestures.current.delete(gestureKey);
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              window.removeEventListener("pointercancel", onCancel);
            };
            const createChild = () => {
              setPreviewSide(null);
              const creationKey = `${parent.id}:${dot.side}`;
              if (creatingChildren.current.has(creationKey)) return;
              creatingChildren.current.add(creationKey);
              void (async () => {
                // NIL-647: `{ type: "selection" }` is its own ActiveTool
                // variant (types.ts), not a "builtin" tool named "selection"
                // -- Excalidraw's own raw tool type for it really is
                // "selection", never "builtin". The wrong shape here used to
                // make `setActiveToolSettled`'s equality check impossible to
                // satisfy (`sameTool` compares `.type` first, and "selection"
                // never equals "builtin"), so this always burned its full
                // 1000ms settle timeout -- measured as a ~1050ms wait before
                // the child note appeared at all -- even though the tool
                // itself had already switched within a frame.
                await interaction.setActiveToolSettled({ type: "selection" });
                await createConnectedChild(parent, dot.side, scene, ui);
              })().finally(() => {
                creatingChildren.current.delete(creationKey);
              });
            };
            const startDrag = () => {
              if (armingDrag) return;
              armingDrag = true;
              setPreviewSide(null);
              void beginArrowDrag(interaction, container, origin).then(() => {
                dragReady = true;
                // Moves can outrun the one frame needed to arm the tool. Replay
                // the latest point after Excalidraw has received pointerdown;
                // if release also won that race, replay it in the same order.
                dispatchCanvasDragPointer("pointermove", {
                  clientX: latest.x,
                  clientY: latest.y,
                  pointerId,
                  pointerType: event.pointerType,
                });
                if (releasedWhileArming) {
                  dispatchCanvasDragPointer("pointerup", {
                    clientX: latest.x,
                    clientY: latest.y,
                    pointerId,
                    pointerType: event.pointerType,
                  });
                  cleanup();
                }
              });
            };
            const onMove = (move: PointerEvent) => {
              if (move.pointerId !== pointerId) return;
              latest = { x: move.clientX, y: move.clientY };
              if (armingDrag) return;
              const distance = Math.hypot(move.clientX - pressedAt.x, move.clientY - pressedAt.y);
              if (distance < HANDLE_DRAG_THRESHOLD_PX) return;
              startDrag();
            };
            const onUp = (up: PointerEvent) => {
              if (up.pointerId !== pointerId) return;
              latest = { x: up.clientX, y: up.clientY };
              if (armingDrag) {
                if (dragReady) cleanup();
                else releasedWhileArming = true;
                return;
              }
              cleanup();
              createChild();
            };
            const onCancel = (cancel: PointerEvent) => {
              if (cancel.pointerId !== pointerId) return;
              cleanup();
              setPreviewSide(null);
              if (dragReady) {
                dispatchCanvasDragPointer("pointercancel", {
                  clientX: latest.x,
                  clientY: latest.y,
                  pointerId,
                  pointerType: event.pointerType,
                });
              }
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onCancel);
          }}
          style={{
            position: "absolute",
            left: dot.x - DOT / 2,
            top: dot.y - DOT / 2,
            width: DOT,
            height: DOT,
            minWidth: DOT,
            minHeight: DOT,
            borderRadius: "50%",
            background: "#ffffff",
            border: "1.5px solid #6965db",
            padding: 0,
            cursor: "crosshair",
            zIndex: stacking.chrome,
          }}
        />
      ))}
    </>
  );
};
