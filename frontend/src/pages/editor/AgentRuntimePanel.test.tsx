// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimePanel } from "./AgentRuntimePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const getConnections = vi.fn();
const startRun = vi.fn();
const promptRun = vi.fn();
const subscribeRun = vi.fn(() => vi.fn());
const listDaemons = vi.fn().mockResolvedValue([]);
const createPairing = vi.fn();
const revokeDaemon = vi.fn();

vi.mock("../../api/agentRuntime", () => ({
  getAgentRuntimeConnections: (...args: unknown[]) => getConnections(...args),
  startAgentRuntimeRun: (...args: unknown[]) => startRun(...args),
  promptAgentRuntimeRun: (...args: unknown[]) => promptRun(...args),
  subscribeAgentRuntimeRun: (...args: unknown[]) => subscribeRun(...args),
  listRuntimeDaemons: (...args: unknown[]) => listDaemons(...args),
  createRuntimeDaemonPairing: (...args: unknown[]) => createPairing(...args),
  revokeRuntimeDaemon: (...args: unknown[]) => revokeDaemon(...args),
}));

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  listDaemons.mockResolvedValue([]);
});

describe("AgentRuntimePanel", () => {
  it("keeps the board surface available when no runtime is connected", async () => {
    getConnections.mockResolvedValue([]);
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentRuntimePanel container={overlay} drawingId="drawing-1" open onClose={vi.fn()} />,
      );
    });
    expect(overlay.textContent).toContain("Runtime not connected");
    expect(overlay.textContent).toContain("The board remains available");
    expect(getConnections).toHaveBeenCalledWith("drawing-1");
    await act(async () => root.unmount());
  });

  it("shows an offline connection but disables agent start", async () => {
    getConnections.mockResolvedValue([
      {
        id: "runtime",
        label: "Herdr",
        audience: { kind: "installation" },
        costBearer: { label: "Instance operator" },
        profiles: [{ id: "default", label: "Default" }],
        health: { connected: false, status: "disconnected" },
      },
    ]);
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentRuntimePanel container={overlay} drawingId="drawing-1" open onClose={vi.fn()} />,
      );
    });
    expect(
      overlay.querySelector<HTMLButtonElement>(".agent-runtime-panel__primary")?.disabled,
    ).toBe(true);
    expect(overlay.textContent).toContain("The canvas is unaffected");
    await act(async () => root.unmount());
  });

  it("starts, observes and prompts a connected runtime run", async () => {
    getConnections.mockResolvedValue([
      {
        id: "runtime",
        label: "Herdr",
        audience: { kind: "installation" },
        costBearer: { label: "Instance operator" },
        profiles: [{ id: "review", label: "Review" }],
        health: { connected: true, status: "connected" },
      },
    ]);
    startRun.mockResolvedValue({
      run: { id: "run-1", displayName: "Board agent", status: "working", capabilities: [] },
      runCapability: "opaque-capability",
      expiresAt: "2026-08-29T20:00:00.000Z",
    });
    promptRun.mockResolvedValue({ id: "run-1", status: "idle" });
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentRuntimePanel container={overlay} drawingId="drawing-1" open onClose={vi.fn()} />,
      );
    });

    const start = [...overlay.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Start agent"),
    );
    await act(async () => start?.click());
    expect(startRun).toHaveBeenCalledWith(
      "drawing-1",
      expect.objectContaining({ connectionId: "runtime", profileId: "review" }),
    );
    expect(overlay.textContent).toContain("working · live");
    expect(subscribeRun).toHaveBeenCalledWith(
      "drawing-1",
      "opaque-capability",
      expect.any(Function),
      expect.any(Function),
    );

    const prompt = overlay.querySelector("textarea");
    await act(async () => {
      if (!prompt) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        prompt,
        "Continue the review",
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...overlay.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Send prompt"),
    );
    await act(async () => send?.click());
    expect(promptRun).toHaveBeenCalledWith("drawing-1", "opaque-capability", "Continue the review");
    expect(overlay.textContent).toContain("idle · live");
    await act(async () => root.unmount());
  });

  it("makes the payer and one-use outbound pairing direction visible without money claims", async () => {
    getConnections.mockResolvedValue([
      {
        id: "daemon:device-1",
        label: "Alice's laptop",
        audience: { kind: "user" },
        costBearer: { label: "Alice" },
        profiles: [{ id: "codex", label: "Codex CLI" }],
        health: { connected: true, status: "connected" },
      },
    ]);
    listDaemons.mockResolvedValue([
      {
        id: "device-1",
        label: "Alice's laptop",
        daemonVersion: "0.16.0",
        planLabel: "ChatGPT Plus",
        limits: [{ label: "Daily limit", value: "Provider managed" }],
        lastSeenAt: "2026-08-30T14:00:00.000Z",
      },
    ]);
    createPairing.mockResolvedValue({
      pairingCode: "exd_pair_visible_once",
      expiresAt: "2026-08-30T15:00:00.000Z",
    });
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentRuntimePanel container={overlay} drawingId="drawing-1" open onClose={vi.fn()} />,
      );
    });
    expect(overlay.textContent).toContain("Cost bearerAliceYour paired runtime");
    expect(overlay.textContent).toContain("Daily limit: Provider managed");
    expect(overlay.textContent).not.toMatch(/[$€£]|cost estimate/i);
    const summary = overlay.querySelector("summary");
    await act(async () => summary?.click());
    const pairButton = [...overlay.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create one-use pairing"),
    );
    await act(async () => pairButton?.click());
    expect(overlay.textContent).toContain("exd_pair_visible_once");
    expect(overlay.textContent).toContain("never opens a connection to your computer");
    await act(async () => root.unmount());
  });

  it("shows an unknown device state and retries when the paired-device list cannot load", async () => {
    getConnections.mockResolvedValue([]);
    listDaemons.mockRejectedValueOnce(new Error("simulated device-list outage"));
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    document.body.append(host, overlay);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <AgentRuntimePanel container={overlay} drawingId="drawing-1" open onClose={vi.fn()} />,
      );
    });

    expect(overlay.querySelector('[role="alert"]')?.textContent).toContain(
      "Paired computers could not be loaded",
    );
    expect(overlay.textContent).not.toContain("No paired computers yet");

    listDaemons.mockResolvedValueOnce([
      {
        id: "device-1",
        label: "Alice's laptop",
        daemonVersion: "0.16.0",
        planLabel: "ChatGPT Plus",
        limits: [{ label: "Plan limit", value: "Provider managed" }],
        lastSeenAt: "2026-08-30T14:00:00.000Z",
      },
    ]);
    const retry = [...overlay.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );
    await act(async () => retry?.click());

    expect(overlay.textContent).toContain("Alice's laptop");
    expect(overlay.querySelector('[role="alert"]')).toBeNull();

    listDaemons.mockRejectedValueOnce(new Error("simulated refresh outage"));
    const refresh = [...overlay.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Refresh runtimes"),
    );
    await act(async () => refresh?.click());

    expect(overlay.querySelector('[role="alert"]')?.textContent).toContain(
      "Paired computers could not be loaded",
    );
    expect(overlay.textContent).toContain("Alice's laptop");
    expect(overlay.textContent).not.toContain("No paired computers yet");
    await act(async () => root.unmount());
  });
});
