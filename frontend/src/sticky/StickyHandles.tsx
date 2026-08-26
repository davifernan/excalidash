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
import React, { useEffect, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
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
import {
  HANDLE_SIDES,
  beginArrowDrag,
  handlePoint,
  noteAt,
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
  interaction: Pick<InteractionCapability, "read" | "setActiveTool">;
  scene: Pick<SceneCapability, "subscribe" | "summaries" | "summaryById">;
  selection: Pick<SelectionCapability, "read">;
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
  viewport,
}) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

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

  if (!canEdit || !layout) return null;

  return (
    <>
      {layout.dots.map((dot) => (
        <button
          key={dot.side}
          type="button"
          aria-label={`Draw an arrow from this note (${dot.side})`}
          data-testid={`sticky-handle-${dot.side}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const note = scene.summaryById(layout.noteId);
            const viewportState = viewport.read();
            const container = containerRef.current;
            if (!note.ok || !note.value || !viewportState.ok || !container) return;

            const from = startPoint(note.value, dot.side);
            const point = projectPoint({ x: from.x, y: from.y }, viewportState.value);
            const rect = container.getBoundingClientRect();
            beginArrowDrag(interaction, container, {
              clientX: rect.left + point.x,
              clientY: rect.top + point.y,
              pointerId: event.pointerId,
              pointerType: event.pointerType,
            });
          }}
          style={{
            position: "absolute",
            left: dot.x - DOT / 2,
            top: dot.y - DOT / 2,
            width: DOT,
            height: DOT,
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
