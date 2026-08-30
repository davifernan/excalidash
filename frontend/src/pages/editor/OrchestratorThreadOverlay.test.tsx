import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OrchestratorThreadOverlay,
  type OrchestratorThreadSurface,
} from "./OrchestratorThreadOverlay";

const anchor = (threadId: string, left: number, elementId = `element-${threadId}`) => ({
  threadId,
  elementId,
  title: `Thread ${threadId}`,
  rect: { left, top: 100, right: left + 220, bottom: 240 },
});

const member = (threadId: string) => ({ threadId, elementId: `element-${threadId}` });

const surface = (
  overrides: Partial<OrchestratorThreadSurface> = {},
): OrchestratorThreadSurface => ({
  anchors: [anchor("alpha", 100), anchor("beta", 500)],
  showInvitation: false,
  clusters: [
    {
      id: "cluster-alpha",
      members: [member("alpha")],
      rect: anchor("alpha", 100).rect,
    },
    {
      id: "cluster-beta",
      members: [member("beta")],
      rect: anchor("beta", 500).rect,
    },
  ],
  offscreenLocators: [],
  active: null,
  backpressure: { blocked: false, occupiedRatio: 0.1, message: null },
  ...overrides,
});

const handlers = () => ({
  onCreate: vi.fn(),
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onJump: vi.fn(),
  onClusterNavigate: vi.fn(),
});

describe("OrchestratorThreadOverlay", () => {
  it("offers an honest pre-thread invitation without inventing message or dispatch semantics", () => {
    const callbacks = handlers();
    render(
      <OrchestratorThreadOverlay
        surface={surface({ anchors: [], clusters: [], showInvitation: true })}
        {...callbacks}
      />,
    );

    expect(screen.getByTestId("orchestrator-thread-invitation")).toHaveTextContent(
      "Where should we coordinate?",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Place shared thread here" }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
  });

  it("switches between two audiences without presenting the action as publication", () => {
    const callbacks = {
      ...handlers(),
      onSwitchAudience: vi.fn(),
      onSendMessage: vi.fn(),
    };
    const openSurface = surface({
      clusters: [],
      active: {
        anchor: anchor("local-alpha", 100, "private-thread:local-alpha"),
        placement: {
          mode: "anchored",
          panelRect: { left: 340, top: 100, right: 700, bottom: 500 },
          direction: null,
          distance: 0,
        },
      },
    });
    const localPanelView = {
      threadId: "local-alpha",
      audience: "private" as const,
      loading: false,
      sending: false,
      canWrite: true,
      error: null,
      publicThreads: [],
      receipts: [],
      dispatch: null,
      events: [
        {
          id: "local-message",
          threadId: "local-alpha",
          sequence: 1,
          actor: { kind: "user" as const, id: "owner", displayName: "Owner" },
          kind: "message" as const,
          payload: { text: "Only on my local history" },
          createdAt: "2026-08-30T02:00:00.000Z",
        },
      ],
    };
    const rendered = render(
      <OrchestratorThreadOverlay surface={openSurface} panelView={localPanelView} {...callbacks} />,
    );

    expect(screen.getByText("Only on my local history")).toBeVisible();
    expect(
      screen.getByText(/Switching opens another thread; it never publishes this one/),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    expect(callbacks.onSwitchAudience).toHaveBeenCalledWith("drawing");
    expect(callbacks.onCreate).not.toHaveBeenCalled();

    rendered.rerender(
      <OrchestratorThreadOverlay
        surface={openSurface}
        panelView={{ ...localPanelView, threadId: "shared-alpha", audience: "drawing", events: [] }}
        {...callbacks}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("never renders runtime completion as confirmed public effect and exposes visible backpressure", () => {
    const callbacks = { ...handlers(), onDispatch: vi.fn() };
    const openSurface = surface({
      clusters: [],
      active: {
        anchor: anchor("shared-alpha", 100),
        placement: {
          mode: "anchored",
          panelRect: { left: 340, top: 100, right: 700, bottom: 650 },
          direction: null,
          distance: 0,
        },
      },
      backpressure: { blocked: true, occupiedRatio: 0.72, message: "Too many visible anchors" },
    });
    render(
      <OrchestratorThreadOverlay
        surface={openSurface}
        panelView={{
          threadId: "shared-alpha",
          audience: "drawing",
          loading: false,
          sending: false,
          canWrite: true,
          error: null,
          events: [],
          publicThreads: [
            { id: "shared-alpha", title: "Release coordination" },
            { id: "shared-beta", title: "Deployment coordination" },
          ],
          receipts: [
            {
              id: "receipt-1",
              drawingId: "drawing-1",
              publicThreadId: "shared-alpha",
              originVisibility: "private",
              objectiveSummary: "Publish the approved comparison",
              targetContextIds: ["context-1"],
              revisionId: "revision-1",
              effectiveCapabilities: ["agent:run", "board:write"],
              expectedArtifacts: ["Board update"],
              runId: "run-1",
              admission: "accepted",
              execution: "succeeded",
              effect: "pending",
              acceptedAt: "2026-08-30T02:00:00.000Z",
              lastObservedAt: "2026-08-30T02:01:00.000Z",
              effectEvidence: null,
              updatedAt: "2026-08-30T02:01:00.000Z",
            },
            {
              id: "receipt-2",
              drawingId: "drawing-1",
              publicThreadId: "shared-alpha",
              originVisibility: "private",
              objectiveSummary: "Publish a Board result that never committed",
              targetContextIds: ["context-1"],
              revisionId: "revision-1",
              effectiveCapabilities: ["agent:run", "board:write"],
              expectedArtifacts: ["Board update"],
              runId: "run-2",
              admission: "accepted",
              execution: "succeeded",
              effect: "failed",
              acceptedAt: "2026-08-30T02:02:00.000Z",
              lastObservedAt: "2026-08-30T02:03:00.000Z",
              effectEvidence: null,
              updatedAt: "2026-08-30T02:04:00.000Z",
            },
          ],
          dispatch: {
            contexts: [{ id: "context-1", frameElementId: "frame-1" }],
            connections: [],
            submitting: false,
            blocked: true,
          },
        }}
        {...callbacks}
      />,
    );

    expect(screen.getByText("Execution finished · publication pending")).toBeVisible();
    expect(screen.getByText("Board effect failed · publication not completed")).toBeVisible();
    expect(screen.queryByText("Effect confirmed on the board")).toBeNull();
    expect(screen.queryByText("Dispatch durably accepted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve a public effect" }));
    expect(screen.getByText(/Dispatch paused: the Board thread view is saturated/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Dispatch publicly" })).toBeDisabled();
  });

  it("keeps message and public-effect drafts when their requests fail", async () => {
    const callbacks = {
      ...handlers(),
      onSendMessage: vi.fn().mockRejectedValue(new Error("message rejected")),
      onDispatch: vi.fn().mockRejectedValue(new Error("dispatch rejected")),
    };
    const openSurface = surface({
      clusters: [],
      active: {
        anchor: anchor("shared-alpha", 100),
        placement: {
          mode: "anchored",
          panelRect: { left: 340, top: 100, right: 700, bottom: 650 },
          direction: null,
          distance: 0,
        },
      },
    });
    render(
      <OrchestratorThreadOverlay
        surface={openSurface}
        panelView={{
          threadId: "shared-alpha",
          audience: "drawing",
          loading: false,
          sending: false,
          canWrite: true,
          error: null,
          events: [],
          publicThreads: [
            { id: "shared-alpha", title: "Release coordination" },
            { id: "shared-beta", title: "Deployment coordination" },
          ],
          receipts: [],
          dispatch: {
            contexts: [{ id: "context-1", frameElementId: "frame-1" }],
            connections: [
              {
                id: "runtime-1",
                label: "Runtime",
                audience: { kind: "installation" },
                profiles: [{ id: "profile-1", label: "Profile" }],
                health: { connected: true, status: "connected" },
              },
            ],
            submitting: false,
            blocked: false,
          },
        }}
        {...callbacks}
      />,
    );

    const message = screen.getByLabelText("Message this audience");
    fireEvent.change(message, { target: { value: "Do not lose this message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await expect(callbacks.onSendMessage).toHaveBeenCalledWith("Do not lose this message");
    expect(message).toHaveValue("Do not lose this message");

    fireEvent.click(screen.getByRole("button", { name: "Approve a public effect" }));
    const objective = screen.getByLabelText("Approved public objective");
    expect(screen.getByLabelText("Public responsibility thread")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Dispatch publicly" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Public responsibility thread"), {
      target: { value: "shared-beta" },
    });
    fireEvent.change(objective, { target: { value: "Do not lose this objective" } });
    fireEvent.change(screen.getByLabelText("Public effect Context"), {
      target: { value: "context-1" },
    });
    fireEvent.change(screen.getByLabelText("Agent runtime connection"), {
      target: { value: "runtime-1" },
    });
    fireEvent.change(screen.getByLabelText("Agent runtime profile"), {
      target: { value: "profile-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dispatch publicly" }));
    await expect(callbacks.onDispatch).toHaveBeenCalledOnce();
    expect(callbacks.onDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ publicThreadId: "shared-beta" }),
    );
    expect(objective).toHaveValue("Do not lose this objective");
    expect(screen.getByRole("button", { name: "Dispatch publicly" })).toBeVisible();
  });

  it("renders Board Cards as the closed state and opens the selected identity", () => {
    const callbacks = handlers();
    render(<OrchestratorThreadOverlay surface={surface()} {...callbacks} />);

    expect(screen.queryByTestId("orchestrator-thread-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Thread beta" }));
    expect(callbacks.onOpen).toHaveBeenCalledWith("element-beta");
  });

  it("opens the selected board address when duplicated cards share a thread identity", () => {
    const callbacks = handlers();
    const original = anchor("alpha", 100);
    const copy = anchor("alpha", 500, "element-alpha-copy");
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          anchors: [original, copy],
          clusters: [
            { id: "cluster-original", members: [member("alpha")], rect: original.rect },
            {
              id: "cluster-copy",
              members: [{ threadId: "alpha", elementId: "element-alpha-copy" }],
              rect: copy.rect,
            },
          ],
        })}
        {...callbacks}
      />,
    );

    const cards = screen.getAllByTestId("orchestrator-thread-card");
    expect(cards[0]).toHaveStyle({ left: "100px" });
    expect(cards[1]).toHaveStyle({ left: "500px" });
    const openButtons = screen.getAllByRole("button", { name: "Open Thread alpha" });
    expect(openButtons).toHaveLength(2);
    fireEvent.click(openButtons[0]!);
    expect(callbacks.onOpen).toHaveBeenCalledWith("element-alpha");
    fireEvent.click(openButtons[1]!);
    expect(callbacks.onOpen).toHaveBeenCalledWith("element-alpha-copy");
  });

  it("renders exactly one fully open panel", () => {
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [
            {
              id: "cluster-beta",
              members: [member("beta")],
              rect: anchor("beta", 500).rect,
            },
          ],
          active: {
            anchor: anchor("alpha", 100),
            placement: {
              mode: "anchored",
              panelRect: { left: 340, top: 100, right: 700, bottom: 386 },
              direction: null,
              distance: 0,
            },
          },
        })}
        {...handlers()}
      />,
    );

    expect(screen.getAllByTestId("orchestrator-thread-panel")).toHaveLength(1);
    expect(screen.getByTestId("orchestrator-thread-panel")).toHaveTextContent("Thread alpha");
    expect(screen.getByRole("button", { name: "Open Thread beta" })).toBeInTheDocument();
  });

  it("makes an unreachable anchor explicit and offers a jump", () => {
    const callbacks = handlers();
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [],
          active: {
            anchor: anchor("alpha", 1400),
            placement: {
              mode: "docked",
              panelRect: { left: 820, top: 200, right: 1180, bottom: 486 },
              direction: "right",
              distance: 420,
            },
          },
        })}
        {...callbacks}
      />,
    );

    expect(screen.getByTestId("orchestrator-thread-panel")).toHaveAttribute("data-mode", "docked");
    fireEvent.click(screen.getByRole("button", { name: /anchor outside the readable view/i }));
    expect(callbacks.onJump).toHaveBeenCalledWith("element-alpha");
  });

  it("disambiguates a visual cluster before navigating to one thread", () => {
    const callbacks = handlers();
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [
            {
              id: "cluster-both",
              members: [member("alpha"), member("beta")],
              rect: { left: 100, top: 100, right: 720, bottom: 240 },
            },
          ],
        })}
        {...callbacks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 threads" }));
    expect(callbacks.onClusterNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Thread beta" }));
    expect(callbacks.onClusterNavigate).toHaveBeenCalledWith({
      kind: "navigate",
      threadId: "beta",
      elementId: "element-beta",
    });
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });

  it("keeps an offscreen crowd to one locator and navigates to one original thread", () => {
    const callbacks = handlers();
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [],
          offscreenLocators: [
            {
              id: "thread-offscreen:right",
              direction: "right",
              members: [member("alpha"), member("beta")],
              left: 1170,
              top: 380,
            },
          ],
        })}
        {...callbacks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2 threads" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Thread alpha" }));
    expect(callbacks.onClusterNavigate).toHaveBeenCalledWith({
      kind: "navigate",
      threadId: "alpha",
      elementId: "element-alpha",
    });
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });

  it("shows backpressure instead of silently hiding saturation", () => {
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          backpressure: {
            blocked: true,
            occupiedRatio: 0.46,
            message: "Thread view saturated — public coordination waits for visible room.",
          },
        })}
        {...handlers()}
      />,
    );

    expect(screen.getByTestId("orchestrator-thread-backpressure")).toHaveTextContent(
      "public coordination waits",
    );
    expect(screen.getByTestId("orchestrator-thread-backpressure")).toHaveTextContent("46%");
  });
});
