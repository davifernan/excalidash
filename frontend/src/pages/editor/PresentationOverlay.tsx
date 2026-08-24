import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  EyeOff,
  Presentation,
  Square,
  StickyNote,
} from "lucide-react";
import type { PresenterNotes, PresenterSnapshot } from "./presenterMode";
import type { FrameSummary } from "./frameNavigator";
import "./PresentationOverlay.css";

export type PresentationUiState = {
  readonly snapshot: PresenterSnapshot;
  readonly isSelf: boolean;
  readonly canTakeover: boolean;
  readonly notes: PresenterNotes;
  readonly isFollowing: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly takeover: () => void;
  readonly jumpToFrame: (frame: FrameSummary) => void;
  readonly setNotes: (text: string) => void;
  readonly setFollowing: (following: boolean) => void;
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
};

/**
 * The presentation surface: a presenter's controls, or an audience banner.
 *
 * One component for both roles because they are one state machine, not two
 * (docs/product/WORKSHOP_PRESENTER.md): whether the room sees the presenter
 * panel or the audience banner is decided entirely by `isSelf`, computed from
 * the same server-authoritative `PresenterSnapshot` everyone in the room
 * receives.
 *
 * Renders nothing while idle -- the empty-slot convention chromeSlots.tsx
 * documents for its own registries applies here too: no chrome for a feature
 * nobody is using.
 */
export const PresentationOverlay = ({
  container,
  frames,
  presenting,
}: {
  container: HTMLElement | null;
  frames: readonly FrameSummary[];
  presenting: PresentationUiState;
}) => {
  const { snapshot } = presenting;
  const [notesDraft, setNotesDraft] = useState(presenting.notes.text);
  useEffect(() => {
    setNotesDraft(presenting.notes.text);
  }, [presenting.notes]);

  const currentFrameIndex = frames.findIndex((frame) => frame.id === snapshot.frameId);

  const jumpBy = (delta: number) => {
    if (frames.length === 0) return;
    const nextIndex =
      currentFrameIndex === -1
        ? delta > 0
          ? 0
          : frames.length - 1
        : Math.min(frames.length - 1, Math.max(0, currentFrameIndex + delta));
    const frame = frames[nextIndex];
    if (frame) presenting.jumpToFrame(frame);
  };

  useEffect(() => {
    if (!presenting.isSelf) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === " ") {
        event.preventDefault();
        jumpBy(1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        jumpBy(-1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting.isSelf, frames, snapshot.frameId]);

  if (!container || snapshot.status === "idle") return null;

  if (presenting.isSelf) {
    return createPortal(
      <div
        className="presentation-overlay presentation-overlay--presenter"
        data-testid="presentation-overlay-presenter"
      >
        <div className="presentation-overlay__header">
          <Presentation size={16} />
          <span>Presenting</span>
          <button
            type="button"
            className="presentation-overlay__stop"
            onClick={presenting.stop}
            data-testid="presentation-stop"
          >
            <Square size={12} /> Stop
          </button>
        </div>
        <div className="presentation-overlay__frames">
          <button
            type="button"
            onClick={() => jumpBy(-1)}
            disabled={frames.length === 0}
            aria-label="Previous frame"
          >
            <ChevronLeft size={16} />
          </button>
          <ul className="presentation-overlay__frame-list">
            {frames.length === 0 ? (
              <li className="presentation-overlay__frame-empty">
                No frames yet -- draw one to navigate by.
              </li>
            ) : (
              frames.map((frame) => (
                <li key={frame.id}>
                  <button
                    type="button"
                    className={
                      frame.id === snapshot.frameId ? "presentation-overlay__frame--current" : ""
                    }
                    onClick={() => presenting.jumpToFrame(frame)}
                    data-testid="presentation-frame-entry"
                  >
                    {frame.name}
                  </button>
                </li>
              ))
            )}
          </ul>
          <button
            type="button"
            onClick={() => jumpBy(1)}
            disabled={frames.length === 0}
            aria-label="Next frame"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <label className="presentation-overlay__notes">
          <span>
            <StickyNote size={14} /> Presenter notes (only you see this)
          </span>
          <textarea
            value={notesDraft}
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={() => presenting.setNotes(notesDraft)}
            placeholder="Notes for this frame..."
            data-testid="presentation-notes"
          />
        </label>
      </div>,
      container,
    );
  }

  return createPortal(
    <div
      className="presentation-overlay presentation-overlay--audience"
      data-testid="presentation-overlay-audience"
    >
      <Presentation size={16} />
      <span className="presentation-overlay__audience-text">
        {snapshot.presenterName || "Someone"} is presenting
        {currentFrameIndex >= 0 ? ` — ${frames[currentFrameIndex]?.name}` : ""}
      </span>
      <button
        type="button"
        onClick={() => presenting.setFollowing(!presenting.isFollowing)}
        data-testid="presentation-follow-toggle"
      >
        {presenting.isFollowing ? <Eye size={14} /> : <EyeOff size={14} />}
        {presenting.isFollowing ? "Following" : "Not following"}
      </button>
      {presenting.canTakeover ? (
        <button type="button" onClick={presenting.takeover} data-testid="presentation-takeover">
          <Crown size={14} /> Take over
        </button>
      ) : null}
    </div>,
    container,
  );
};
