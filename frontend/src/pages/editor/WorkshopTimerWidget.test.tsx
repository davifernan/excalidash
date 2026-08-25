import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkshopTimerWidget } from "./WorkshopTimerWidget";
import type {
  SyncedWorkshopTimerSnapshot,
  WorkshopTimerAction,
  WorkshopTimerController,
} from "./workshopTimer";
import { playWorkshopTimerChime, primeWorkshopTimerAudio } from "./workshopTimerChime";

vi.mock("./workshopTimerChime", () => ({
  isWorkshopTimerSoundMuted: vi.fn(() => false),
  setWorkshopTimerSoundMuted: vi.fn(),
  primeWorkshopTimerAudio: vi.fn(),
  playWorkshopTimerChime: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const snapshot = (
  status: SyncedWorkshopTimerSnapshot["status"],
  overrides: Partial<SyncedWorkshopTimerSnapshot> = {},
): SyncedWorkshopTimerSnapshot => ({
  drawingId: "drawing-1",
  status,
  endsAt: status === "running" ? Date.now() + 60_000 : null,
  remainingMs: 60_000,
  serverNow: Date.now(),
  serverClockOffsetMs: 0,
  ...overrides,
});

const makeController = (
  status: SyncedWorkshopTimerSnapshot["status"],
): { controller: WorkshopTimerController; sendCommand: ReturnType<typeof vi.fn> } => {
  const sendCommand = vi.fn<(action: WorkshopTimerAction, durationMs?: number) => void>();
  return { controller: { snapshot: snapshot(status), sendCommand }, sendCommand };
};

describe("pressing Start closes the settings panel (NIL-578)", () => {
  it("collapses the panel as soon as Start is clicked, with no second click", () => {
    const { controller } = makeController("idle");
    render(<WorkshopTimerWidget canEdit timer={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /workshop timer/i }));
    expect(screen.getByText("Minutes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(controller.sendCommand).toHaveBeenCalledWith("start", 10 * 60_000);
    expect(screen.queryByText("Minutes")).not.toBeInTheDocument();
  });

  it("gegenprobe: Pause does not close the panel -- only Start does", () => {
    // Same widget, but the timer is already running, so Pause/Resume/Stop
    // are on screen instead of Start. If the auto-close were accidentally
    // wired to "any control click" instead of specifically Start, this
    // would fail too.
    const { controller } = makeController("running");
    render(<WorkshopTimerWidget canEdit timer={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /workshop timer/i }));
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /pause/i }));

    expect(controller.sendCommand).toHaveBeenCalledWith("pause");
    // The test double doesn't re-render with a new snapshot on command, so
    // this can't assert "now shows Resume" -- the observable claim here is
    // just that the panel itself is still mounted, unlike the Start case.
    expect(document.querySelector(".workshop-timer__panel")).toBeInTheDocument();
  });

  it("does not close the panel when the minutes field fails validation", () => {
    const { controller } = makeController("idle");
    render(<WorkshopTimerWidget canEdit timer={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /workshop timer/i }));
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(controller.sendCommand).not.toHaveBeenCalled();
    expect(screen.getByText("Minutes")).toBeInTheDocument();
  });
});

describe("the end-of-timer chime (NIL-578)", () => {
  it("plays once on a live running -> finished transition", () => {
    const { controller } = makeController("running");
    const { rerender } = render(<WorkshopTimerWidget canEdit timer={controller} />);
    expect(playWorkshopTimerChime).not.toHaveBeenCalled();

    controller.snapshot = snapshot("finished");
    rerender(<WorkshopTimerWidget canEdit timer={controller} />);

    expect(playWorkshopTimerChime).toHaveBeenCalledTimes(1);
  });

  it("gegenprobe: does not play for a page load that starts already finished", () => {
    // A viewer opening the board after the timer already ended sees the
    // finished snapshot on mount -- that is not a transition they witnessed
    // and must stay silent.
    const { controller } = makeController("finished");
    render(<WorkshopTimerWidget canEdit timer={controller} />);
    expect(playWorkshopTimerChime).not.toHaveBeenCalled();
  });

  it("primes audio from a real click on the widget", () => {
    const { controller } = makeController("idle");
    render(<WorkshopTimerWidget canEdit timer={controller} />);
    expect(primeWorkshopTimerAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /workshop timer/i }));

    expect(primeWorkshopTimerAudio).toHaveBeenCalledTimes(1);
  });
});
