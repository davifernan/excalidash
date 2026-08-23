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
import React, { useCallback, useEffect, useState } from "react";
import { createExcalidrawAdapter, type ExcalidrawAdapter } from "../integrations/excalidraw";
import type {
  ElementId,
  ElementSummary,
  InteractionState,
  SelectionState,
} from "../integrations/excalidraw/types";
import { projectPoint } from "../integrations/excalidraw/viewport";
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
  excalidrawAPI: { current: any };
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
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

function layoutFor(adapter: ExcalidrawAdapter, api: any, hoveredId: string | null): Layout | null {
  const interaction = adapter.interaction.read();
  // Contract gap (NIL-322): InteractionState has no dragging element. Keep
  // this one raw read until the frozen capability can preserve that guard.
  const dragging = !!api?.getAppState?.()?.draggingElement;
  if (!interaction.ok || isBusy(interaction.value, dragging)) return null;

  const scene = adapter.scene.summaries();
  const selection = adapter.selection.read();
  const viewport = adapter.viewport.read();
  if (!scene.ok || !selection.ok || !viewport.ok) return null;

  const note =
    scene.value.find((element) => element.id === hoveredId && isStickyNote(element)) ??
    selectedNote(scene.value, selection.value);
  // A rotated note would need rotated points; nobody rotates a sticky note, and
  // guessing wrong would put the dots somewhere they do not belong.
  if (!note || note.angle) return null;

  return {
    noteId: note.id,
    dots: HANDLE_SIDES.map((side) => {
      const scene = handlePoint(note, side);
      const { x, y } = projectPoint({ x: scene.x, y: scene.y }, viewport.value);
      return { side, x, y };
    }),
  };
}

const signature = (layout: Layout | null) =>
  layout
    ? `${layout.noteId}:${layout.dots.map((d) => `${Math.round(d.x)},${Math.round(d.y)}`).join("|")}`
    : "";

export const StickyHandles: React.FC<Props> = ({ excalidrawAPI, containerRef, canEdit }) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const getAdapter = useCallback(
    () =>
      createExcalidrawAdapter({
        api: () => excalidrawAPI.current,
        container: () => containerRef.current,
        canEdit: () => canEdit,
      }),
    [canEdit, containerRef, excalidrawAPI],
  );

  // Excalidraw does not say what the pointer is over, so the note under it is
  // worked out here. Sticky notes are plain axis-aligned boxes, which makes
  // that a comparison rather than a hit test.
  useEffect(() => {
    const adapter = getAdapter();
    const container = containerRef.current;
    if (!container || !canEdit) return;

    const onMove = (event: PointerEvent) => {
      const interaction = adapter.interaction.read();
      if (!interaction.ok || interaction.value.activeTool.type !== "selection") {
        setHoveredId(null);
        return;
      }
      const point = adapter.viewport.toScene({ x: event.clientX, y: event.clientY });
      const scene = adapter.scene.summaries();
      if (!point.ok || !scene.ok) {
        setHoveredId(null);
        return;
      }
      const note = noteAt(scene.value, isStickyNote, point.value.x, point.value.y);
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
  }, [canEdit, containerRef, getAdapter]);

  useEffect(() => {
    if (!canEdit) return;
    const adapter = getAdapter();

    const refresh = () =>
      setLayout((current) => {
        const next = layoutFor(adapter, excalidrawAPI.current, hoveredId);
        return signature(current) === signature(next) ? current : next;
      });

    refresh();
    return adapter.scene.subscribe(refresh);
  }, [canEdit, excalidrawAPI, getAdapter, hoveredId]);

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
            const adapter = getAdapter();
            const api = excalidrawAPI.current;
            const note = adapter.scene.summaryById(layout.noteId);
            const viewport = adapter.viewport.read();
            const container = containerRef.current;
            if (!api || !note.ok || !note.value || !viewport.ok || !container) return;

            const from = startPoint(note.value, dot.side);
            const point = projectPoint({ x: from.x, y: from.y }, viewport.value);
            const rect = container.getBoundingClientRect();
            beginArrowDrag(api, container, {
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
            zIndex: 4,
          }}
        />
      ))}
    </>
  );
};
