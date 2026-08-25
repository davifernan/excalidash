import { useEffect, useId, useRef, useState } from "react";
import { BellRing, Clock3, Pause, Play, Plus, Square, Volume2, VolumeX } from "lucide-react";
import type { WorkshopTimerController } from "./workshopTimer";
import { getWorkshopTimerRemainingMs } from "./workshopTimer";
import {
  isWorkshopTimerSoundMuted,
  playWorkshopTimerChime,
  primeWorkshopTimerAudio,
  setWorkshopTimerSoundMuted,
} from "./workshopTimerChime";
import "./WorkshopTimerWidget.css";

const formatRemaining = (remainingMs: number): string => {
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const useRemainingMs = (timer: WorkshopTimerController): number => {
  const [remainingMs, setRemainingMs] = useState(() => getWorkshopTimerRemainingMs(timer.snapshot));
  useEffect(() => {
    const update = () => setRemainingMs(getWorkshopTimerRemainingMs(timer.snapshot));
    update();
    if (timer.snapshot.status !== "running") return;
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [timer.snapshot]);
  return remainingMs;
};

/**
 * The shared countdown, in Excalidraw's bottom Footer slot.
 *
 * It began life in the top-right cluster, where Miro and FigJam put theirs.
 * That column is capped near 275px here, and every button in it takes width
 * from the collaborator avatars, which collapse into a "+N" chip once they drop
 * below 76px -- measured, not guessed. A countdown is something you glance at
 * rather than hunt for, so it sits at the bottom beside the zoom controls and
 * leaves the faces alone. The Footer slot was empty; this is what it is for.
 */
export const WorkshopTimerWidget = ({
  canEdit,
  timer,
}: {
  canEdit: boolean;
  timer: WorkshopTimerController;
}) => {
  // Two editors on one page would otherwise share one id, and the second
  // widget's label would focus the first widget's input.
  const inputId = useId();
  const [expanded, setExpanded] = useState(false);
  const [minutes, setMinutes] = useState("10");
  const [soundMuted, setSoundMuted] = useState(isWorkshopTimerSoundMuted);
  const remainingMs = useRemainingMs(timer);
  const { status } = timer.snapshot;
  const active = status === "running" || status === "paused";
  // The one state that gets the "main toolbar" white treatment (NIL-578
  // follow-up from Davi): idle, paused, and finished all read as "not
  // currently running" and share the muted grey instead. The color itself
  // is the state signal -- white means running -- so this stays a plain
  // boolean, not an animation.
  const isRunning = status === "running";
  const summary =
    status === "finished" ? "Time's up" : active ? formatRemaining(remainingMs) : "Timer";

  // Initialised from the live status, not "idle": a viewer who opens the
  // board after the timer already finished must not hear a chime for a
  // transition that happened before they arrived.
  const previousStatusRef = useRef(status);
  // Which run finished, not merely "did a transition happen": a socket
  // disconnect resets the local snapshot to idle (useEditorCollaboration.ts's
  // resetConnectionState -> workshopTimer.reset()), and rejoining fetches the
  // server's still-"finished" snapshot fresh (socket.ts's join handler) --
  // both without this component ever unmounting. That reads as a second
  // idle -> finished transition to React, even though nothing new finished
  // (Hans-Friedrich, PR #148). `endsAt` names the run: it's set while running
  // and (deliberately) cleared once finished, so remembering the last one we
  // actually chimed for -- across resets, not just across renders -- tells
  // a real new finish apart from the same finish observed twice.
  const lastRunningEndsAtRef = useRef<number | null>(null);
  const chimedForEndsAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (status === "running" && timer.snapshot.endsAt !== null) {
      lastRunningEndsAtRef.current = timer.snapshot.endsAt;
    }
    if (previousStatusRef.current !== "finished" && status === "finished") {
      const runId = lastRunningEndsAtRef.current;
      if (runId === null || chimedForEndsAtRef.current !== runId) {
        playWorkshopTimerChime();
        chimedForEndsAtRef.current = runId;
      }
    }
    previousStatusRef.current = status;
  }, [status, timer.snapshot.endsAt]);

  // Any real interaction with the widget is the user gesture the Web Audio
  // API requires -- priming here, not only in `start`, means someone who
  // merely opens the panel or pauses/resumes still gets to hear the room's
  // chime later.
  const withAudioPrime =
    <Args extends unknown[]>(fn: (...args: Args) => void) =>
    (...args: Args) => {
      primeWorkshopTimerAudio();
      fn(...args);
    };

  const start = withAudioPrime(() => {
    const durationMinutes = Number(minutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1_440)
      return;
    timer.sendCommand("start", durationMinutes * 60_000);
    // The settings menu has done its job the moment Start is pressed --
    // leaving it open just makes the person who started the timer clean up
    // after their own click (NIL-578). Pause/Resume/Stop/+1 min stay open;
    // those are usually followed by another glance at the same controls.
    setExpanded(false);
  });

  const toggleSound = withAudioPrime(() => {
    setSoundMuted((current) => {
      const next = !current;
      setWorkshopTimerSoundMuted(next);
      return next;
    });
  });

  return (
    <div
      className={`workshop-timer${expanded ? " workshop-timer--expanded" : ""}${isRunning ? " workshop-timer--running" : ""}`}
      // No CSS reads this -- the finished/idle/paused color is already the
      // muted-grey default `.workshop-timer--running` overrides (NIL-578
      // review, Hans-Friedrich: the previous `.workshop-timer--finished`
      // class had no rule left targeting it once that color logic moved).
      // Kept as a plain data attribute, not a class, so it stays legible as
      // a DOM/test hook rather than looking like dead styling again.
      data-timer-status={status}
      aria-live={status === "finished" ? "assertive" : "off"}
    >
      <button
        type="button"
        className="workshop-timer__summary"
        aria-expanded={expanded}
        aria-label={`Workshop timer: ${summary}`}
        onClick={withAudioPrime(() => setExpanded((current) => !current))}
      >
        {status === "finished" ? <BellRing size={18} /> : <Clock3 size={18} />}
        <span className="workshop-timer__time">{summary}</span>
        {status === "paused" ? <span className="workshop-timer__badge">Paused</span> : null}
      </button>
      {expanded ? (
        <div className="workshop-timer__panel">
          {canEdit ? (
            <>
              <div className="workshop-timer__start-row">
                <label htmlFor={inputId}>Minutes</label>
                <input
                  id={inputId}
                  type="number"
                  min="1"
                  max="1440"
                  step="1"
                  inputMode="numeric"
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                />
                <button type="button" onClick={start}>
                  {active ? "Restart" : "Start"}
                </button>
              </div>
              {active ? (
                <div className="workshop-timer__controls">
                  <button
                    type="button"
                    onClick={withAudioPrime(() =>
                      timer.sendCommand(status === "running" ? "pause" : "resume"),
                    )}
                  >
                    {status === "running" ? <Pause size={16} /> : <Play size={16} />}
                    {status === "running" ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    onClick={withAudioPrime(() => timer.sendCommand("add-minute"))}
                  >
                    <Plus size={16} />1 min
                  </button>
                  <button type="button" onClick={withAudioPrime(() => timer.sendCommand("stop"))}>
                    <Square size={14} /> Stop
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="workshop-timer__readonly">Only editors can control the timer.</p>
          )}
          <button
            type="button"
            className="workshop-timer__sound-toggle"
            aria-pressed={soundMuted}
            onClick={toggleSound}
          >
            {soundMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            {soundMuted ? "Sound off" : "Sound on"}
          </button>
        </div>
      ) : null}
    </div>
  );
};
