import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OrchestratorThreadOverlay,
  type OrchestratorThreadSurface,
} from "./OrchestratorThreadOverlay";

const anchor = (threadId: string, left: number) => ({
  threadId,
  elementId: `element-${threadId}`,
  title: `Thread ${threadId}`,
  rect: { left, top: 100, right: left + 220, bottom: 240 },
});

const surface = (
  overrides: Partial<OrchestratorThreadSurface> = {},
): OrchestratorThreadSurface => ({
  anchors: [anchor("alpha", 100), anchor("beta", 500)],
  showInvitation: false,
  clusters: [
    {
      id: "cluster-alpha",
      memberThreadIds: ["alpha"],
      rect: anchor("alpha", 100).rect,
    },
    {
      id: "cluster-beta",
      memberThreadIds: ["beta"],
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
    fireEvent.click(screen.getByRole("button", { name: "Place thread here" }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
  });

  it("renders Board Cards as the closed state and opens the selected identity", () => {
    const callbacks = handlers();
    render(<OrchestratorThreadOverlay surface={surface()} {...callbacks} />);

    expect(screen.queryByTestId("orchestrator-thread-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Thread beta" }));
    expect(callbacks.onOpen).toHaveBeenCalledWith("beta");
  });

  it("renders exactly one fully open panel", () => {
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [
            {
              id: "cluster-beta",
              memberThreadIds: ["beta"],
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
    expect(callbacks.onJump).toHaveBeenCalledWith("alpha");
  });

  it("disambiguates a visual cluster before navigating to one thread", () => {
    const callbacks = handlers();
    render(
      <OrchestratorThreadOverlay
        surface={surface({
          clusters: [
            {
              id: "cluster-both",
              memberThreadIds: ["alpha", "beta"],
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
              memberThreadIds: ["alpha", "beta"],
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
