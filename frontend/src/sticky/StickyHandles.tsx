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
import { projectPoint, readViewport } from "../integrations/excalidraw/viewport";
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
type Layout = { noteId: string; dots: Dot[] };

type Props = {
  excalidrawAPI: { current: any };
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
};

/** The single selected note, if exactly one note is selected. */
function selectedNote(elements: readonly any[], appState: any): any | null {
  const ids = Object.entries(appState?.selectedElementIds ?? {})
    .filter(([, selected]) => selected)
    .map(([id]) => id);
  if (ids.length !== 1) return null;
  const found = elements.find((element: any) => element.id === ids[0]);
  return found && isStickyNote(found) ? found : null;
}

/** Nothing to show while another tool is in hand or a gesture is underway. */
function isBusy(appState: any): boolean {
  return (
    appState.activeTool?.type !== "selection" ||
    !!appState.editingTextElement ||
    !!appState.draggingElement ||
    !!appState.resizingElement ||
    !!appState.newElement
  );
}

function layoutFor(api: any, hoveredId: string | null): Layout | null {
  const appState = api?.getAppState?.();
  if (!appState || isBusy(appState)) return null;

  const elements = api.getSceneElements();
  const note =
    elements.find((element: any) => element.id === hoveredId && isStickyNote(element)) ??
    selectedNote(elements, appState);
  // A rotated note would need rotated points; nobody rotates a sticky note, and
  // guessing wrong would put the dots somewhere they do not belong.
  if (!note || note.angle) return null;

  return {
    noteId: note.id,
    dots: HANDLE_SIDES.map((side) => {
      const scene = handlePoint(note, side);
      const { x, y } = projectPoint({ x: scene.x, y: scene.y }, readViewport(appState));
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

  // Excalidraw does not say what the pointer is over, so the note under it is
  // worked out here. Sticky notes are plain axis-aligned boxes, which makes
  // that a comparison rather than a hit test.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canEdit) return;

    const onMove = (event: PointerEvent) => {
      const api = excalidrawAPI.current;
      const appState = api?.getAppState?.();
      if (!appState || appState.activeTool?.type !== "selection") {
        setHoveredId(null);
        return;
      }
      const rect = container.getBoundingClientRect();
      const x = (event.clientX - rect.left) / appState.zoom.value - appState.scrollX;
      const y = (event.clientY - rect.top) / appState.zoom.value - appState.scrollY;
      const note = noteAt(api.getSceneElements(), isStickyNote, x, y);
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
  }, [canEdit, containerRef, excalidrawAPI]);

  useEffect(() => {
    const api = excalidrawAPI.current;
    if (!api?.onChange || !canEdit) return;

    const refresh = () =>
      setLayout((current) => {
        const next = layoutFor(excalidrawAPI.current, hoveredId);
        return signature(current) === signature(next) ? current : next;
      });

    refresh();
    return api.onChange(refresh);
  }, [canEdit, excalidrawAPI, hoveredId]);

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
            const api = excalidrawAPI.current;
            const note = api
              ?.getSceneElements()
              .find((element: any) => element.id === layout.noteId);
            const container = containerRef.current;
            if (!api || !note || !container) return;

            const from = startPoint(note, dot.side);
            const viewport = projectPoint(
              { x: from.x, y: from.y },
              readViewport(api.getAppState()),
            );
            const rect = container.getBoundingClientRect();
            beginArrowDrag(api, container, {
              clientX: rect.left + viewport.x,
              clientY: rect.top + viewport.y,
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
