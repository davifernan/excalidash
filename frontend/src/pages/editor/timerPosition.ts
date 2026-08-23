/**
 * Where the workshop timer widget sits on screen, for this viewer only.
 *
 * NIL-376: this is deliberately *not* the timer's countdown. `workshopTimer.ts`
 * already carries that server-synced (see `bindSocketWorkshopTimer`); nothing
 * here talks to a socket. What lives here is the on-screen position of the
 * draggable widget -- a purely local UI preference. Two people in the same
 * room can each drag the widget to a different corner without either of them
 * moving the other's.
 *
 * Position is expressed as an offset from the bottom-right corner of the
 * editor root, not from the top-left. Anchoring to the corner the widget
 * defaults to means a resize that only grows the window (the common case)
 * never has to relocate a widget nobody moved.
 */

export type TimerPosition = {
  /** Distance from the right edge of the container, in px. */
  right: number;
  /** Distance from the bottom edge of the container, in px. */
  bottom: number;
};

export type TimerBounds = {
  containerWidth: number;
  containerHeight: number;
  widgetWidth: number;
  widgetHeight: number;
};

/** Same margin the rest of the chrome uses -- see `--editor-container-padding`. */
export const DEFAULT_TIMER_MARGIN = 16;

export const DEFAULT_TIMER_POSITION: TimerPosition = {
  right: DEFAULT_TIMER_MARGIN,
  bottom: DEFAULT_TIMER_MARGIN,
};

/**
 * Keep the widget fully inside the container.
 *
 * Clamped independently on each axis so a container that shrank on only one
 * dimension (a portrait rotate, a docked sidebar) does not snap the widget to
 * a corner it was nowhere near.
 */
export const clampTimerPosition = (position: TimerPosition, bounds: TimerBounds): TimerPosition => {
  const maxRight = Math.max(0, bounds.containerWidth - bounds.widgetWidth);
  const maxBottom = Math.max(0, bounds.containerHeight - bounds.widgetHeight);
  return {
    right: Math.min(Math.max(0, position.right), maxRight),
    bottom: Math.min(Math.max(0, position.bottom), maxBottom),
  };
};

export type TimerNudgeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

const NUDGE_STEP = 8;
const NUDGE_STEP_LARGE = 32;

/**
 * Arrow-key repositioning for a widget whose drag handle is keyboard-focused.
 * Left/Right and Up/Down move along the axis they name; Shift widens the
 * step for a widget dragged far from its default corner.
 */
export const nudgeTimerPosition = (
  position: TimerPosition,
  key: TimerNudgeKey,
  bounds: TimerBounds,
  options?: { large?: boolean },
): TimerPosition => {
  const step = options?.large ? NUDGE_STEP_LARGE : NUDGE_STEP;
  const delta: TimerPosition = { right: 0, bottom: 0 };
  if (key === "ArrowUp") delta.bottom = step;
  else if (key === "ArrowDown") delta.bottom = -step;
  else if (key === "ArrowLeft") delta.right = step;
  else if (key === "ArrowRight") delta.right = -step;

  return clampTimerPosition(
    { right: position.right + delta.right, bottom: position.bottom + delta.bottom },
    bounds,
  );
};

/**
 * Whether the widget sits close enough to the top of the container that its
 * panel should open downward instead of the usual upward -- the same
 * off-screen-panel bug small-windows.spec.ts guards for the default corner,
 * generalised to a widget that can now be anywhere.
 */
export const shouldOpenPanelDownward = (
  position: TimerPosition,
  bounds: TimerBounds,
  panelHeight: number,
): boolean => {
  const topOffset = bounds.containerHeight - position.bottom - bounds.widgetHeight;
  return topOffset < panelHeight + DEFAULT_TIMER_MARGIN;
};

/**
 * The horizontal twin of `shouldOpenPanelDownward`. The panel's default
 * growth direction is leftward from the widget's right edge, which matches
 * the default bottom-right corner: growing rightward from there ran the
 * minutes field off the right edge of a narrow window, the mirror image of
 * the bug small-windows.spec.ts originally caught on the left edge. Flips
 * back to rightward growth once the widget is close enough to the left edge
 * that leftward growth would run off instead.
 */
export const shouldOpenPanelRightward = (
  position: TimerPosition,
  bounds: TimerBounds,
  panelWidth: number,
): boolean => {
  // Leftward growth anchors at the widget's *right* edge and extends toward
  // the container's left edge -- the available room is the gap between them,
  // not the (unrelated) gap to the left of the widget's own left edge.
  const leftOffset = bounds.containerWidth - position.right;
  return leftOffset < panelWidth + DEFAULT_TIMER_MARGIN;
};

const STORAGE_PREFIX = "excalidash:workshop-timer-position:";

export const timerPositionStorageKey = (drawingId: string): string =>
  `${STORAGE_PREFIX}${drawingId}`;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Never throws: a corrupt or foreign value just falls back to the default. */
export const parseStoredTimerPosition = (raw: string | null): TimerPosition | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      isFiniteNumber(parsed.right) &&
      isFiniteNumber(parsed.bottom)
    ) {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // Ignore -- foreign or corrupt localStorage value.
  }
  return null;
};
