import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sparkles } from "lucide-react";
import * as api from "../../api";
import { WorkshopTimerCorner } from "./WorkshopTimerCorner";
import { createIdleWorkshopTimerSnapshot } from "./workshopTimer";
import type { WorkshopTimerController } from "./workshopTimer";
import { EditorFeatureRegistry, defineEditorFeature } from "./featureRegistry";
import { workshopTimerFeature } from "./workshopTimerFeature";
import { votingFeature } from "./votingFeature";
import { commentsFeature } from "./comments/commentsFeature";

vi.mock("../../api");

/**
 * NIL-655's own acceptance bar (kickoff doc + NIL-610): a new registration
 * must appear here without editing this toolbar. These tests exercise that
 * by building `EditorFeatureRegistry` instances that were never imported by
 * WorkshopTimerCorner.tsx -- if adding an entry to one of them changed what
 * the component renders, the registry is doing its job.
 */

const drawingId = "drawing-1";

const makeTimer = (): WorkshopTimerController => ({
  snapshot: createIdleWorkshopTimerSnapshot(drawingId),
  sendCommand: vi.fn(),
});

const baseProps = {
  drawingId,
  boardId: drawingId,
  canEdit: true,
  canComment: true,
  connectionStatus: "connected" as const,
  votingStatus: "idle" as const,
  onStartVote: vi.fn(),
  onOpenComments: vi.fn(),
};

let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getUserPreferences).mockResolvedValue({});
  vi.mocked(api.updateUserPreferences).mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

describe("WorkshopTimerCorner as a feature-registry consumer", () => {
  it("renders the timer plus every other applicable feature as a generic button, with no overflow yet", async () => {
    render(
      <WorkshopTimerCorner
        {...baseProps}
        container={container}
        accessLevel="owner"
        timer={makeTimer()}
      />,
    );

    expect(await screen.findByTestId("workshop-timer-corner")).toBeInTheDocument();
    expect(screen.getByTestId("feature-toolbar-button-voting")).toBeInTheDocument();
    expect(screen.getByTestId("feature-toolbar-button-comments")).toBeInTheDocument();
    // The generic buttons invoke straight through the registry.
    fireEvent.click(screen.getByTestId("feature-toolbar-button-voting"));
    expect(baseProps.onStartVote).toHaveBeenCalledOnce();
  });

  it("shows nothing but the drag handle for a guest with no board access", async () => {
    render(
      <WorkshopTimerCorner
        {...baseProps}
        container={container}
        accessLevel="none"
        canEdit={false}
        canComment={false}
        timer={makeTimer()}
      />,
    );

    await waitFor(() => expect(api.getUserPreferences).toHaveBeenCalled());
    expect(screen.getByTestId("workshop-timer-corner-handle")).toBeInTheDocument();
    expect(screen.queryByTestId("feature-toolbar-button-voting")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feature-toolbar-button-comments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feature-toolbar-menu-trigger")).not.toBeInTheDocument();
  });

  it("a fourth registered feature appears in the overflow menu without any change to this component", async () => {
    const extraFeature = defineEditorFeature({
      id: "sparkle-demo" as never,
      name: "Sparkle demo",
      icon: Sparkles,
      shortcut: null,
      isApplicable: () => true,
      invoke: vi.fn(),
    });
    const registry = new EditorFeatureRegistry([
      workshopTimerFeature,
      votingFeature,
      commentsFeature,
      extraFeature,
    ]);

    render(
      <WorkshopTimerCorner
        {...baseProps}
        container={container}
        accessLevel="owner"
        timer={makeTimer()}
        registry={registry}
      />,
    );

    // Two inline slots are already spent on voting and comments; the new
    // fourth feature is the one that overflows.
    expect(await screen.findByTestId("feature-toolbar-menu-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("feature-toolbar-button-sparkle-demo")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("feature-toolbar-menu-trigger"));
    const overflowButton = await screen.findByTestId("feature-toolbar-menu-invoke-sparkle-demo");
    expect(overflowButton).toHaveTextContent("Sparkle demo");
    fireEvent.click(overflowButton);
    expect(extraFeature.invoke).toHaveBeenCalledOnce();
  });

  it("unchecking a feature in the customize list removes its inline button and persists the choice", async () => {
    render(
      <WorkshopTimerCorner
        {...baseProps}
        container={container}
        accessLevel="owner"
        timer={makeTimer()}
      />,
    );

    fireEvent.click(await screen.findByTestId("feature-toolbar-menu-trigger"));
    const commentsToggle = await screen.findByTestId("feature-toolbar-toggle-comments");
    expect(commentsToggle).toBeChecked();

    fireEvent.click(commentsToggle);

    await waitFor(() =>
      expect(screen.queryByTestId("feature-toolbar-button-comments")).not.toBeInTheDocument(),
    );
    expect(vi.mocked(api.updateUserPreferences)).toHaveBeenCalledWith({
      toolbarFeatureIds: ["workshop-timer", "voting"],
    });
  });
});
