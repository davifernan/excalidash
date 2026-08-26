import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";

describe("connection failure frame", () => {
  const setReducedMotion = (matches: boolean) => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  };

  afterEach(() => {
    vi.useRealTimers();
    setReducedMotion(false);
  });

  it("has no DOM in the normal connected state", () => {
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status="connected" />);

    expect(host.querySelector("[data-testid='connection-status-frame']")).toBeNull();
    expect(host.querySelector("[data-testid='connection-status-badge']")).toBeNull();
    host.remove();
  });

  it("renders a disconnected frame and badge without reconnecting dots", () => {
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status="offline" />);

    const frame = host.querySelector<HTMLElement>("[data-testid='connection-status-frame']");
    expect(frame?.dataset.status).toBe("offline");
    expect(host.querySelector("[data-testid='connection-status-badge']")?.textContent).toBe(
      "Disconnected",
    );
    expect(host.querySelector("[data-testid='connection-status-announcement']")?.textContent).toBe(
      "Disconnected",
    );
    expect(host.querySelector("[data-testid='connection-status-dots']")).toBeNull();
    host.remove();
  });

  it("keeps reconnecting dots still when reduced motion is requested", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status="reconnecting" />);
    const dots = host.querySelector("[data-testid='connection-status-dots']");
    expect(dots?.textContent).toBe("...");

    act(() => vi.advanceTimersByTime(1_800));
    expect(dots?.textContent).toBe("...");
    host.remove();
  });

  it("updates persistent live-region text when the connection state changes", () => {
    const host = document.createElement("div");
    document.body.append(host);

    const { rerender } = render(<ConnectionStatusBadge container={host} status="offline" />);
    const announcement = host.querySelector("[data-testid='connection-status-announcement']");
    expect(announcement?.textContent).toBe("Disconnected");

    rerender(<ConnectionStatusBadge container={host} status="reconnecting" />);
    expect(announcement?.textContent).toBe("Reconnecting");
    expect(announcement?.getAttribute("role")).toBe("status");
    expect(announcement?.getAttribute("aria-live")).toBe("polite");
    expect(announcement?.getAttribute("aria-atomic")).toBe("true");
    host.remove();
  });

  it("cycles reconnecting dots from one through three and back", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);

    render(<ConnectionStatusBadge container={host} status="reconnecting" />);
    const dots = host.querySelector("[data-testid='connection-status-dots']");
    expect(dots?.textContent).toBe(".");

    act(() => vi.advanceTimersByTime(450));
    expect(dots?.textContent).toBe("..");
    act(() => vi.advanceTimersByTime(450));
    expect(dots?.textContent).toBe("...");
    act(() => vi.advanceTimersByTime(450));
    expect(dots?.textContent).toBe(".");
    host.remove();
  });

  it("renders nothing without an Excalidraw overlay container", () => {
    const { container } = render(<ConnectionStatusBadge container={null} status="offline" />);
    expect(container.querySelector("[data-testid='connection-status-frame']")).toBeNull();
  });
});
