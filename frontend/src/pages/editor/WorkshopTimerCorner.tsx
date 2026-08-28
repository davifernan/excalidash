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
 *
 * NIL-655: this corner is also the one on-canvas entry point for every other
 * ExcaliDash feature registered in featureRegistry.ts -- NIL-610 built the
 * registry, but shipped no consumer, so nothing besides the timer ever
 * appeared here. The corner itself keeps its name and its `data-testid`s
 * unchanged: e2e/tests/workshop-timer-position.spec.ts and
 * workshop-timer-signal.spec.ts measure this exact container and handle by
 * those ids, and "the corner the timer (and now its siblings) live in" is
 * still an accurate name for it, so renaming it would only cost a rewrite of
 * both specs for no behavioural gain. The timer keeps its rich, always-open
 * pill; every other applicable, enabled feature gets a plain icon button
 * next to it, generically, from `registry.applicable()` -- that genericity is
 * the actual probe of whether NIL-610's registry does its job: registering a
 * fourth feature needs no change here to appear (see FeatureToolbarButton
 * below and featureToolbar.test.tsx).
 */
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, RotateCcw, SlidersHorizontal } from "lucide-react";
import { WorkshopTimerWidget } from "./WorkshopTimerWidget";
import { primeWorkshopTimerAudio } from "./workshopTimerChime";
import { useDraggableTimerPosition } from "./useDraggableTimerPosition";
import { useToolbarFeaturePreferences } from "./useToolbarFeaturePreferences";
import { editorFeatureRegistry } from "./editorFeatures";
import type {
  EditorFeatureContext,
  EditorFeatureId,
  EditorFeatureMetadata,
  EditorFeatureRegistry,
  EditorFeatureTarget,
} from "./featureRegistry";
import type { WorkshopTimerController } from "./workshopTimer";
import type { ConnectionStatus } from "./useEditorCollaboration";
import type { VotingStatus } from "./votingMode";
import { stacking } from "../../integrations/excalidraw/stacking";
import "./WorkshopTimerCorner.css";

const BOARD_TARGET: EditorFeatureTarget = { kind: "board" };

/**
 * Only the timer earns a bespoke widget -- it is the one feature with real
 * running state (a countdown, Start/Pause/Stop). Every other entry, present
 * or future, renders through this generic button: an icon, a label as the
 * accessible name and tooltip, and a click that goes through the registry's
 * own `invoke`, which re-checks applicability itself rather than trusting
 * that this button was only ever shown when applicable.
 */
const FeatureToolbarButton: React.FC<{
  feature: EditorFeatureMetadata;
  onClick: () => void;
}> = ({ feature, onClick }) => {
  const Icon = feature.icon;
  return (
    <button
      type="button"
      className="workshop-timer-corner__action"
      aria-label={feature.name}
      title={feature.name}
      data-testid={`feature-toolbar-button-${feature.id}`}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
};

export const WorkshopTimerCorner: React.FC<{
  container: HTMLElement | null;
  drawingId: string | undefined;
  boardId: string | null;
  accessLevel: EditorFeatureContext["accessLevel"];
  canEdit: boolean;
  canComment: boolean;
  connectionStatus: ConnectionStatus;
  votingStatus: VotingStatus;
  timer: WorkshopTimerController;
  onStartVote: () => void;
  onOpenComments: () => void;
  /** Overridable for tests only -- production always uses the real, composed registry. */
  registry?: EditorFeatureRegistry;
}> = ({
  container,
  drawingId,
  boardId,
  accessLevel,
  canEdit,
  canComment,
  connectionStatus,
  votingStatus,
  timer,
  onStartVote,
  onOpenComments,
  registry = editorFeatureRegistry,
}) => {
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [timerExpanded, setTimerExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const { position, isDragging, openDownward, openRightward, handleProps } =
    useDraggableTimerPosition({ drawingId, container, widgetRef });

  const featureContext: EditorFeatureContext = useMemo(
    () => ({
      boardId,
      accessLevel,
      canEdit,
      canComment,
      connectionStatus,
      votingStatus,
      target: BOARD_TARGET,
      actions: {
        openWorkshopTimer: () => setTimerExpanded(true),
        startVote: onStartVote,
        openComments: () => onOpenComments(),
      },
    }),
    [
      boardId,
      accessLevel,
      canEdit,
      canComment,
      connectionStatus,
      votingStatus,
      onStartVote,
      onOpenComments,
    ],
  );

  const applicableFeatures = registry.applicable(featureContext);
  const timerFeature = applicableFeatures.find((feature) => feature.id === "workshop-timer");
  // Every applicable feature that is not the timer -- the timer is not
  // user-removable (Davi, NIL-655: "Timer bleibt da"), so it never appears
  // in the customize list below either.
  const otherFeatures = applicableFeatures.filter((feature) => feature.id !== "workshop-timer");

  const knownFeatureIds = useMemo(
    () => registry.all().map((feature) => feature.id) as readonly EditorFeatureId[],
    [registry],
  );
  const selection = useToolbarFeaturePreferences(knownFeatureIds);
  const enabledOtherFeatures = otherFeatures.filter((feature) => selection.isEnabled(feature.id));

  // Two inline slots keep the bar from growing wider than the timer pill
  // itself in the common case (Timer + Voting + Comments = one overflow-free
  // row); a third registered feature is the deliberate case that exercises
  // overflow -- see featureToolbar.test.tsx's "overflow" case for the proof
  // and NIL-655's PR screenshots for what it looks like with several more.
  const MAX_INLINE_FEATURES = 2;
  const inlineFeatures = enabledOtherFeatures.slice(0, MAX_INLINE_FEATURES);
  const overflowFeatures = enabledOtherFeatures.slice(MAX_INLINE_FEATURES);
  // The same trigger doubles as "show what didn't fit" and "customize what's
  // here" -- whenever there is at least one non-timer applicable feature,
  // both questions have something to answer. Shown even with zero overflow
  // so a guest with only Comments applicable can still turn it off.
  const showMenuTrigger = otherFeatures.length > 0;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Closing the menu when nothing in it is applicable anymore (e.g. voting
  // just started elsewhere and left "Start a vote" inapplicable) avoids a
  // stale panel offering entries that would now be silently refused.
  useEffect(() => {
    if (menuOpen && otherFeatures.length === 0) setMenuOpen(false);
  }, [menuOpen, otherFeatures.length]);

  if (!container) return null;

  const invoke = (id: EditorFeatureId) => {
    void registry.invoke(id, featureContext);
    setMenuOpen(false);
  };

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
      {timerFeature ? (
        <WorkshopTimerWidget
          timer={timer}
          canEdit={canEdit}
          expanded={timerExpanded}
          onExpandedChange={setTimerExpanded}
        />
      ) : null}
      {timerFeature && canEdit && timer.snapshot.durationMs !== null ? (
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
      {inlineFeatures.map((feature) => (
        <FeatureToolbarButton
          key={feature.id}
          feature={feature}
          onClick={() => invoke(feature.id)}
        />
      ))}
      {showMenuTrigger ? (
        <div className="workshop-timer-corner__menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="workshop-timer-corner__action"
            aria-label="More features"
            title="More features"
            aria-expanded={menuOpen}
            aria-haspopup="true"
            data-testid="feature-toolbar-menu-trigger"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <SlidersHorizontal size={14} />
          </button>
          {menuOpen ? (
            <div
              className="workshop-timer-corner__menu"
              style={{ zIndex: stacking.anchoredOverlay }}
              data-testid="feature-toolbar-menu"
            >
              {overflowFeatures.length > 0 ? (
                <div className="workshop-timer-corner__menu-section">
                  {overflowFeatures.map((feature) => {
                    const Icon = feature.icon;
                    return (
                      <button
                        key={feature.id}
                        type="button"
                        className="workshop-timer-corner__menu-item"
                        data-testid={`feature-toolbar-menu-invoke-${feature.id}`}
                        onClick={() => invoke(feature.id)}
                      >
                        <Icon size={14} />
                        <span>{feature.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {overflowFeatures.length > 0 && otherFeatures.length > 0 ? (
                <div className="workshop-timer-corner__menu-divider" />
              ) : null}
              {otherFeatures.length > 0 ? (
                <div className="workshop-timer-corner__menu-section">
                  <div className="workshop-timer-corner__menu-heading">Customize toolbar</div>
                  {otherFeatures.map((feature) => (
                    <label key={feature.id} className="workshop-timer-corner__menu-item">
                      <input
                        type="checkbox"
                        checked={selection.isEnabled(feature.id)}
                        data-testid={`feature-toolbar-toggle-${feature.id}`}
                        onChange={() => selection.toggle(feature.id)}
                      />
                      <span>{feature.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>,
    container,
  );
};
