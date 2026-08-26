/**
 * Where the workshop timer lives: bottom-right by default, and wherever this
 * viewer last left it after that.
 *
 * NIL-376: this replaces the split between the desktop copy (which sat in
 * Excalidraw's Footer tunnel, flex-positioned bottom-left next to the zoom
 * controls -- never actually "bottom-right") and MobileTimerCorner.tsx (a
 * fixed bottom-left portal, because Excalidraw renders no Footer at all on
 * the mobile layout). Both constraints go away at once by not using the
 * Footer for this anymore: a free-floating, absolutely-positioned widget in
 * `ui.overlayRoot()` works identically on every layout, which is also why the
 * Footer slot in chromeSlots.tsx ships empty in this PR (see that file's "An
 * empty slot" note).
 *
 * Dragging is on its own handle, not the timer pill itself. The pill's
 * summary button already has a job -- expand/collapse, and Start/Pause/Stop
 * once open -- and a widget that is both draggable and clickable on the same
 * surface is exactly the interaction bug NIL-374 warned about ("Start-/Close-
 * Verhalten"). A separate handle means a pointer down on the pill is always a
 * click, and a pointer down on the handle is always a move; neither has to
 * guess about the other.
 *
 * Position is local only -- see timerPosition.ts's file comment for why that
 * is not the same claim as "the countdown is local".
 */
import type React from "react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { GripVertical, RotateCcw } from "lucide-react";
import { WorkshopTimerWidget } from "./WorkshopTimerWidget";
import { primeWorkshopTimerAudio } from "./workshopTimerChime";
import { useDraggableTimerPosition } from "./useDraggableTimerPosition";
import type { WorkshopTimerController } from "./workshopTimer";
import "./WorkshopTimerCorner.css";

export const WorkshopTimerCorner: React.FC<{
  container: HTMLElement | null;
  drawingId: string | undefined;
  canEdit: boolean;
  timer: WorkshopTimerController;
}> = ({ container, drawingId, canEdit, timer }) => {
  const widgetRef = useRef<HTMLDivElement | null>(null);

  const { position, isDragging, openDownward, openRightward, handleProps } =
    useDraggableTimerPosition({ drawingId, container, widgetRef });

  if (!container) return null;

  return createPortal(
    <div
      ref={widgetRef}
      className={[
        "workshop-timer-corner",
        isDragging && "workshop-timer-corner--dragging",
        openDownward && "workshop-timer-corner--panel-downward",
        openRightward && "workshop-timer-corner--panel-rightward",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ right: `${position.right}px`, bottom: `${position.bottom}px` }}
      data-testid="workshop-timer-corner"
    >
      <button
        type="button"
        className="workshop-timer-corner__handle"
        aria-label="Move timer (arrow keys to nudge, Home to reset)"
        title="Move timer"
        data-testid="workshop-timer-corner-handle"
        {...handleProps}
      >
        <GripVertical size={14} />
      </button>
      <WorkshopTimerWidget timer={timer} canEdit={canEdit} />
      {canEdit && timer.snapshot.durationMs !== null ? (
        <button
          type="button"
          className="workshop-timer-corner__restart"
          aria-label="Restart timer"
          title="Restart timer"
          data-testid="workshop-timer-restart"
          onClick={() => {
            primeWorkshopTimerAudio();
            timer.sendCommand("restart");
          }}
        >
          <RotateCcw size={12} />
        </button>
      ) : null}
    </div>,
    container,
  );
};
