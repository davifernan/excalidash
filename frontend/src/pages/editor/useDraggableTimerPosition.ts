/**
 * Drag, clamp, persist, nudge -- the DOM half of timerPosition.ts.
 *
 * Kept apart from timerPosition.ts's pure functions so the maths stays
 * testable without a browser, and apart from WorkshopTimerWidget.tsx so the
 * widget itself stays exactly what it was: this hook only ever answers
 * "where", never "what does the timer say".
 *
 * Every ref read here happens inside an effect or an event handler, never
 * during render -- react-hooks/refs enforces that, and the reason is real:
 * `container` and the widget's own size are read live because a resize can
 * change either between one render and the next, so this hook mirrors both
 * into state instead of reading `.current` inline while rendering.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TIMER_POSITION,
  clampTimerPosition,
  nudgeTimerPosition,
  parseStoredTimerPosition,
  shouldOpenPanelDownward,
  shouldOpenPanelRightward,
  timerPositionStorageKey,
  type TimerBounds,
  type TimerNudgeKey,
  type TimerPosition,
} from "./timerPosition";

const readStoredPosition = (drawingId: string | undefined): TimerPosition => {
  if (!drawingId || typeof window === "undefined") return DEFAULT_TIMER_POSITION;
  try {
    return (
      parseStoredTimerPosition(window.localStorage.getItem(timerPositionStorageKey(drawingId))) ??
      DEFAULT_TIMER_POSITION
    );
  } catch {
    // Storage can throw (private mode, quota); the default position is fine.
    return DEFAULT_TIMER_POSITION;
  }
};

const writeStoredPosition = (drawingId: string | undefined, position: TimerPosition) => {
  if (!drawingId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(timerPositionStorageKey(drawingId), JSON.stringify(position));
  } catch {
    // Not worth surfacing -- the widget still works, it just resets on reload.
  }
};

/** Movement below this, in either direction, is a click on the handle, not a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * A generous estimate of the panel's open height -- the real value depends on
 * read-only vs. editable content, and measuring it on every drag frame is not
 * worth the cost. Erring high flips the panel to open downward a little
 * earlier than strictly necessary near the top edge, never later.
 */
const ESTIMATED_PANEL_HEIGHT = 180;

/** Matches WorkshopTimerWidget.css's `width: min(270px, calc(100vw - 2rem))`. */
const ESTIMATED_PANEL_WIDTH = 270;

const emptyBounds: TimerBounds = {
  containerWidth: 0,
  containerHeight: 0,
  widgetWidth: 0,
  widgetHeight: 0,
};

export const useDraggableTimerPosition = ({
  drawingId,
  container,
  widgetRef,
}: {
  drawingId: string | undefined;
  container: HTMLElement | null;
  widgetRef: React.RefObject<HTMLElement | null>;
}) => {
  const [position, setPosition] = useState<TimerPosition>(() => readStoredPosition(drawingId));
  const [isDragging, setIsDragging] = useState(false);
  const [bounds, setBounds] = useState<TimerBounds>(emptyBounds);
  const dragStart = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPosition: TimerPosition;
    moved: boolean;
  } | null>(null);

  // A drawing switch (same tab, different id) re-reads that board's own
  // remembered position instead of carrying the previous board's along.
  useEffect(() => {
    setPosition(readStoredPosition(drawingId));
  }, [drawingId]);

  // The one place that reads `container` and `widgetRef.current` outside an
  // event handler -- an effect, not render. Re-measures on every container
  // resize (window resize, sidebar opening) and re-clamps the position
  // against whatever the new bounds turn out to be, so a resize can never
  // strand the widget past an edge that moved.
  useEffect(() => {
    const widget = widgetRef.current;
    if (!container || !widget || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next: TimerBounds = {
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        widgetWidth: widget.offsetWidth,
        widgetHeight: widget.offsetHeight,
      };
      setBounds(next);
      setPosition((current) => clampTimerPosition(current, next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(widget);
    return () => observer.disconnect();
  }, [container, widgetRef]);

  const commitPosition = useCallback(
    (next: TimerPosition) => {
      setPosition(next);
      writeStoredPosition(drawingId, next);
    },
    [drawingId],
  );

  const reset = useCallback(() => commitPosition(DEFAULT_TIMER_POSITION), [commitPosition]);

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      dragStart.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPosition: position,
        moved: false,
      };
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [position],
  );

  const onHandlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragStart.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      setIsDragging(true);
      // Right/bottom offsets grow the opposite direction from client x/y.
      const next = clampTimerPosition(
        { right: drag.startPosition.right - dx, bottom: drag.startPosition.bottom - dy },
        bounds,
      );
      setPosition(next);
    },
    [bounds],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragStart.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.moved) {
        writeStoredPosition(drawingId, position);
      }
      dragStart.current = null;
      setIsDragging(false);
    },
    [drawingId, position],
  );

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Home") {
        event.preventDefault();
        reset();
        return;
      }
      if (
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight"
      ) {
        return;
      }
      event.preventDefault();
      const next = nudgeTimerPosition(position, event.key as TimerNudgeKey, bounds, {
        large: event.shiftKey,
      });
      commitPosition(next);
    },
    [bounds, commitPosition, position, reset],
  );

  return {
    position,
    isDragging,
    openDownward: shouldOpenPanelDownward(position, bounds, ESTIMATED_PANEL_HEIGHT),
    openRightward: shouldOpenPanelRightward(position, bounds, ESTIMATED_PANEL_WIDTH),
    reset,
    handleProps: {
      onPointerDown: onHandlePointerDown,
      onPointerMove: onHandlePointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown: onHandleKeyDown,
    },
  };
};
