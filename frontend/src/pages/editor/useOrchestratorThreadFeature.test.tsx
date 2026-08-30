import type React from "react";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import {
  readOrchestratorThreadAnchor,
  withExcalidashData,
} from "../../integrations/excalidraw/customData";
import { ok } from "../../integrations/excalidraw/errors";
import type { ElementId, ElementSummary, SceneOp } from "../../integrations/excalidraw/types";
import { useOrchestratorThreadFeature } from "./useOrchestratorThreadFeature";
import * as threadApi from "../../api/orchestratorThreads";
import * as runtimeApi from "../../api/agentRuntime";
import * as instructionApi from "../../api/instructionApprovals";
import { notify } from "../../notifications";

vi.mock("../../api/orchestratorThreads", () => ({
  getOrchestratorThreads: vi.fn(async () => []),
  getOrCreateLocalOrchestratorThread: vi.fn(),
  getOrchestratorThreadEvents: vi.fn(async () => []),
  registerSharedOrchestratorThread: vi.fn(),
  appendOrchestratorThreadMessage: vi.fn(),
  getPublicDispatchReceipts: vi.fn(async () => []),
  createPublicDispatch: vi.fn(),
}));
vi.mock("../../api/agentRuntime", () => ({ getAgentRuntimeConnections: vi.fn(async () => []) }));
vi.mock("../../api/instructionApprovals", () => ({
  getInstructionContexts: vi.fn(async () => []),
}));
vi.mock("../../notifications", () => ({ notify: vi.fn() }));

const viewportState = {
  zoom: 1,
  scrollX: 0,
  scrollY: 0,
  offsetLeft: 0,
  offsetTop: 0,
  width: 1200,
  height: 760,
};

const persistedAnchor = (): ElementSummary => ({
  id: "element-alpha" as ElementId,
  type: "rectangle",
  x: 120,
  y: 90,
  width: 260,
  height: 156,
  angle: 0,
  isDeleted: false,
  frameId: null,
  containerId: null,
  link: null,
  customData: withExcalidashData(
    {},
    { orchestratorThread: { threadId: "alpha", title: "Release coordination" } },
  ),
  name: null,
  boundElements: null,
  startBinding: null,
  endBinding: null,
});

const makeAdapter = (
  root: HTMLElement,
  elements: ElementSummary[],
  apply: (ops: readonly SceneOp[]) => void = () => {},
  subscribe: (listener: () => void) => () => void = () => () => {},
): ExcalidrawAdapter =>
  ({
    scene: {
      summaries: () => ok(elements),
      subscribe,
      apply: (ops: readonly SceneOp[]) => {
        apply(ops);
        return ok(undefined);
      },
    },
    viewport: {
      read: () => ok(viewportState),
      toViewport: (point: { x: number; y: number }) => ok(point),
      toScene: (point: { x: number; y: number }) => ok(point),
      subscribeScroll: () => () => {},
      scrollToElement: () =>
        ok({ viewport: viewportState, bounds: [0, 0, 1200, 760], zoomClamped: false }),
    },
    ui: { overlayRoot: () => ok(root) },
  }) as unknown as ExcalidrawAdapter;

const Harness: React.FC<{
  adapter: ExcalidrawAdapter;
  canEdit?: boolean;
  isReady?: boolean;
  onRender?: () => void;
  drawingId?: string;
  currentUserId?: string | null;
  socketRef?: any;
}> = ({
  adapter,
  canEdit = true,
  isReady = true,
  onRender,
  drawingId,
  currentUserId = null,
  socketRef,
}) => {
  onRender?.();
  const { orchestratorThreadOverlay, createThread } = useOrchestratorThreadFeature({
    adapter,
    canEdit,
    isReady,
    drawingId,
    currentUserId,
    socketRef: socketRef ?? (createRef() as any),
  });
  return (
    <>
      <button type="button" onClick={createThread}>
        Create
      </button>
      {orchestratorThreadOverlay}
    </>
  );
};

describe("useOrchestratorThreadFeature", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([]);
    vi.mocked(threadApi.getOrchestratorThreadEvents).mockResolvedValue([]);
    vi.mocked(runtimeApi.getAgentRuntimeConnections).mockResolvedValue([]);
    vi.mocked(instructionApi.getInstructionContexts).mockResolvedValue([]);
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    root.remove();
  });

  it("discovers the persisted Board Card at the same position after remount", async () => {
    const adapter = makeAdapter(root, [persistedAnchor()]);
    const first = render(<Harness adapter={adapter} />);
    await screen.findByRole("button", { name: "Open Release coordination" });
    const before = screen.getByTestId("orchestrator-thread-card");
    expect(before).toHaveStyle({ left: "120px", top: "90px", width: "260px", height: "156px" });

    first.unmount();
    render(<Harness adapter={adapter} />);
    await screen.findByRole("button", { name: "Open Release coordination" });
    const after = screen.getByTestId("orchestrator-thread-card");
    expect(after).toHaveStyle({ left: "120px", top: "90px", width: "260px", height: "156px" });
  });

  it("stops a permanently rejected shared-card registration and tells the user", async () => {
    vi.useFakeTimers();
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockRejectedValue({
      response: { status: 400 },
    });
    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(threadApi.registerSharedOrchestratorThread).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledWith(
      "error",
      "A shared thread card could not be registered.",
      expect.objectContaining({
        key: "orchestrator-thread-registration:element-alpha",
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(threadApi.registerSharedOrchestratorThread).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("subscribes only after the editor handle becomes ready", async () => {
    const adapter = makeAdapter(root, [persistedAnchor()]);
    const rendered = render(<Harness adapter={adapter} isReady={false} />);
    expect(screen.queryByRole("button", { name: "Open Release coordination" })).toBeNull();

    rendered.rerender(<Harness adapter={adapter} isReady />);
    expect(await screen.findByRole("button", { name: "Open Release coordination" })).toBeVisible();
  });

  it("projects a rotated Board Card around its element centre", async () => {
    const rotated = { ...persistedAnchor(), angle: Math.PI / 2 };
    render(<Harness adapter={makeAdapter(root, [rotated])} />);

    await screen.findByRole("button", { name: "Open Release coordination" });
    const style = screen.getByTestId("orchestrator-thread-card").style;
    expect(Number.parseFloat(style.left)).toBeCloseTo(172);
    expect(Number.parseFloat(style.top)).toBeCloseTo(38);
    expect(Number.parseFloat(style.width)).toBeCloseTo(156);
    expect(Number.parseFloat(style.height)).toBeCloseTo(260);
  });

  it("creates and selects one shared anchor in one scene write", async () => {
    const calls: readonly SceneOp[][] = [];
    const adapter = makeAdapter(root, [], (ops) => (calls as SceneOp[][]).push([...ops]));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-2222-4333-8444-555555555555");
    render(<Harness adapter={adapter} />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].map((op) => op.kind)).toEqual(["insert", "select"]);
    const insert = calls[0][0];
    expect(insert.kind).toBe("insert");
    if (insert.kind !== "insert") throw new Error("expected insert");
    expect(insert.elements).toHaveLength(1);
    // updateScene does not hydrate skeletons. A raw rectangle without the
    // editor's required groupIds/version/seed fields crashes the interactive
    // canvas; construction must go through Excalidraw's element builder.
    expect((insert.elements[0] as unknown as Record<string, unknown>).groupIds).toEqual([]);
    expect((insert.elements[0] as unknown as Record<string, unknown>).seed).toEqual(
      expect.any(Number),
    );
    expect(readOrchestratorThreadAnchor({ customData: insert.elements[0].customData })).toEqual({
      threadId: "11111111-2222-4333-8444-555555555555",
      title: "Orchestrator 1111",
    });
  });

  it("does not create a shared Board Card for a viewer without edit access", () => {
    const apply = vi.fn();
    render(<Harness adapter={makeAdapter(root, [], apply)} canEdit={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not cover a populated board with the empty-board invitation", async () => {
    const ordinaryElement = {
      ...persistedAnchor(),
      id: "ordinary-element" as ElementId,
      customData: null,
    };
    render(<Harness adapter={makeAdapter(root, [ordinaryElement])} />);

    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(screen.queryByTestId("orchestrator-thread-invitation")).toBeNull();
  });

  it("does not rerender an unchanged thread surface for unrelated scene changes", async () => {
    const ordinaryElement = {
      ...persistedAnchor(),
      id: "ordinary-element" as ElementId,
      customData: null,
    };
    let sceneChanged: () => void = () => {};
    const adapter = makeAdapter(root, [ordinaryElement], undefined, (listener) => {
      sceneChanged = listener;
      return () => {};
    });
    const renders = vi.fn();
    render(<Harness adapter={adapter} onRender={renders} />);

    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    const settledRenderCount = renders.mock.calls.length;

    await act(
      () =>
        new Promise<void>((resolve) => {
          sceneChanged();
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(renders).toHaveBeenCalledTimes(settledRenderCount);
  });

  it("keeps local and multiplayer histories separate when the audience control changes", async () => {
    const local = {
      id: "server-local",
      drawingId: "drawing-1",
      audience: { kind: "private" as const, userId: "owner-1" },
      title: "Local orchestrator thread",
      anchor: { kind: "private" as const, x: 850, y: 140 },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const shared = {
      id: "server-shared",
      drawingId: "drawing-1",
      audience: { kind: "drawing" as const },
      title: "Release coordination",
      anchor: { kind: "drawing" as const, elementId: "element-alpha" },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([local, shared]);
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockResolvedValue(shared);
    vi.mocked(threadApi.getOrchestratorThreadEvents).mockImplementation(async (_drawing, id) => [
      {
        id: `${id}-event`,
        threadId: id,
        sequence: 1,
        actor: { kind: "user", id: "owner-1", displayName: "Owner" },
        kind: "message",
        payload: { text: id === local.id ? "private-history" : "shared-history" },
        createdAt: "2026-08-30T02:00:00.000Z",
      },
    ]);

    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Local orchestrator thread" }));
    expect(await screen.findByText("private-history")).toBeVisible();
    expect(screen.queryByText("shared-history")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    expect(await screen.findByText("shared-history")).toBeVisible();
    expect(screen.queryByText("private-history")).toBeNull();
    expect(threadApi.getOrCreateLocalOrchestratorThread).not.toHaveBeenCalled();
  });

  it("does not let a late receipt snapshot overwrite a newer socket transition", async () => {
    const shared = {
      id: "server-shared",
      drawingId: "drawing-1",
      audience: { kind: "drawing" as const },
      title: "Release coordination",
      anchor: { kind: "drawing" as const, elementId: "element-alpha" },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    let resolveSnapshot!: (receipts: threadApi.PublicDispatchReceipt[]) => void;
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([shared]);
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockResolvedValue(shared);
    vi.mocked(threadApi.getPublicDispatchReceipts).mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const listeners = new Map<string, (value: any) => void>();
    const socket = {
      on: vi.fn((event: string, listener: (value: any) => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
    };
    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
        socketRef={{ current: socket }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Release coordination" }));
    await waitFor(() => expect(threadApi.getPublicDispatchReceipts).toHaveBeenCalledOnce());
    const receipt = {
      id: "receipt-1",
      drawingId: "drawing-1",
      publicThreadId: shared.id,
      originVisibility: "private" as const,
      objectiveSummary: "Publish the approved comparison",
      targetContextIds: ["context-1"],
      revisionId: "revision-1",
      effectiveCapabilities: ["agent:run", "board:write"],
      expectedArtifacts: ["Board update"],
      runId: "run-1",
      admission: "accepted" as const,
      execution: "running" as const,
      effect: "pending" as const,
      executionReason: null,
      costBearer: { label: "Instance operator" },
      acceptedAt: "2026-08-30T02:00:00.000Z",
      lastObservedAt: "2026-08-30T02:02:00.000Z",
      effectEvidence: null,
      updatedAt: "2026-08-30T02:02:00.000Z",
    };
    act(() => listeners.get("agent.dispatch.receipt.updated")?.(receipt));
    expect(await screen.findByText("Running · last confirmed by runtime")).toBeVisible();

    act(() =>
      resolveSnapshot([
        {
          ...receipt,
          execution: "queued",
          lastObservedAt: null,
          updatedAt: "2026-08-30T02:00:00.000Z",
        },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByText("Running · last confirmed by runtime")).toBeVisible(),
    );
    expect(screen.queryByText("Dispatch durably accepted")).toBeNull();
  });

  it("keeps message pending state attached to the thread whose request owns it", async () => {
    const local = {
      id: "server-local",
      drawingId: "drawing-1",
      audience: { kind: "private" as const, userId: "owner-1" },
      title: "Local orchestrator thread",
      anchor: { kind: "private" as const, x: 850, y: 140 },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const shared = {
      id: "server-shared",
      drawingId: "drawing-1",
      audience: { kind: "drawing" as const },
      title: "Release coordination",
      anchor: { kind: "drawing" as const, elementId: "element-alpha" },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const pending = new Map<string, (event: threadApi.AgentThreadEventDTO) => void>();
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([local, shared]);
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockResolvedValue(shared);
    vi.mocked(threadApi.appendOrchestratorThreadMessage).mockImplementation(
      async (_drawingId, threadId) => new Promise((resolve) => pending.set(threadId, resolve)),
    );
    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Local orchestrator thread" }));
    fireEvent.change(await screen.findByLabelText("Message this audience"), {
      target: { value: "local pending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(pending.has(local.id)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Multiplayer" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    const sharedComposer = await screen.findByLabelText("Message this audience");
    fireEvent.change(sharedComposer, {
      target: { value: "shared pending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(pending.has(shared.id)).toBe(true));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await act(async () => {
      pending.get(local.id)?.({
        id: "local-event",
        threadId: local.id,
        sequence: 1,
        actor: { kind: "user", id: "owner-1", displayName: "Owner" },
        kind: "message",
        payload: { text: "local pending" },
        createdAt: "2026-08-30T02:01:00.000Z",
      });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Message this audience")).toHaveValue("shared pending");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    act(() =>
      pending.get(shared.id)?.({
        id: "shared-event",
        threadId: shared.id,
        sequence: 1,
        actor: { kind: "user", id: "owner-1", displayName: "Owner" },
        kind: "message",
        payload: { text: "shared pending" },
        createdAt: "2026-08-30T02:02:00.000Z",
      }),
    );
    await waitFor(() => expect(screen.getByText("shared pending")).toBeVisible());
    expect(screen.getByLabelText("Message this audience")).toHaveValue("");
  });

  it("clears a thread-history error when switching back to a cached thread", async () => {
    const local = {
      id: "server-local",
      drawingId: "drawing-1",
      audience: { kind: "private" as const, userId: "owner-1" },
      title: "Local orchestrator thread",
      anchor: { kind: "private" as const, x: 850, y: 140 },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const shared = {
      id: "server-shared",
      drawingId: "drawing-1",
      audience: { kind: "drawing" as const },
      title: "Release coordination",
      anchor: { kind: "drawing" as const, elementId: "element-alpha" },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([local, shared]);
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockResolvedValue(shared);
    vi.mocked(threadApi.getOrchestratorThreadEvents).mockImplementation(async (_drawing, id) => {
      if (id === shared.id) throw new Error("shared history unavailable");
      return [
        {
          id: "local-event",
          threadId: local.id,
          sequence: 1,
          actor: { kind: "user", id: "owner-1", displayName: "Owner" },
          kind: "message",
          payload: { text: "cached private history" },
          createdAt: "2026-08-30T02:00:00.000Z",
        },
      ];
    });

    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open Local orchestrator thread" }));
    expect(await screen.findByText("cached private history")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This thread history could not be loaded.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Local" }));
    expect(await screen.findByText("cached private history")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("keeps dispatch pending state attached to the origin thread whose request owns it", async () => {
    const local = {
      id: "server-local",
      drawingId: "drawing-1",
      audience: { kind: "private" as const, userId: "owner-1" },
      title: "Local orchestrator thread",
      anchor: { kind: "private" as const, x: 850, y: 140 },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const shared = {
      id: "server-shared",
      drawingId: "drawing-1",
      audience: { kind: "drawing" as const },
      title: "Release coordination",
      anchor: { kind: "drawing" as const, elementId: "element-alpha" },
      createdAt: "2026-08-30T02:00:00.000Z",
      updatedAt: "2026-08-30T02:00:00.000Z",
    };
    const pending = new Map<string, (receipt: threadApi.PublicDispatchReceipt) => void>();
    vi.mocked(threadApi.getOrchestratorThreads).mockResolvedValue([local, shared]);
    vi.mocked(threadApi.registerSharedOrchestratorThread).mockResolvedValue(shared);
    vi.mocked(instructionApi.getInstructionContexts).mockResolvedValue([
      { id: "context-1", frameElementId: "frame-1" },
    ]);
    vi.mocked(runtimeApi.getAgentRuntimeConnections).mockResolvedValue([
      {
        id: "runtime-1",
        label: "Runtime",
        audience: { kind: "installation" },
        costBearer: { label: "Instance operator" },
        profiles: [{ id: "profile-1", label: "Profile" }],
        health: { connected: true, status: "connected" },
      },
    ]);
    vi.mocked(threadApi.createPublicDispatch).mockImplementation(
      async (_drawingId, originThreadId) =>
        new Promise((resolve) => pending.set(originThreadId, resolve)),
    );
    render(
      <Harness
        adapter={makeAdapter(root, [persistedAnchor()])}
        drawingId="drawing-1"
        currentUserId="owner-1"
      />,
    );

    const submitDispatch = async (summary: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Approve a public effect" }));
      await screen.findByRole("button", { name: "Dispatch publicly" });
      fireEvent.change(screen.getByLabelText("Approved public objective"), {
        target: { value: summary },
      });
      fireEvent.change(screen.getByLabelText("Public responsibility thread"), {
        target: { value: shared.id },
      });
      fireEvent.change(screen.getByLabelText("Public effect Context"), {
        target: { value: "context-1" },
      });
      fireEvent.change(screen.getByLabelText("Agent runtime connection"), {
        target: { value: "runtime-1" },
      });
      fireEvent.change(screen.getByLabelText("Agent runtime profile"), {
        target: { value: "profile-1" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Dispatch via Runtime · charged to Instance operator" }),
      );
    };
    const receipt = (id: string): threadApi.PublicDispatchReceipt => ({
      id,
      drawingId: "drawing-1",
      publicThreadId: shared.id,
      originVisibility: "private",
      objectiveSummary: id,
      targetContextIds: ["context-1"],
      revisionId: "revision-1",
      effectiveCapabilities: ["agent:run", "board:write"],
      expectedArtifacts: ["Board update"],
      runId: `run-${id}`,
      admission: "accepted",
      execution: "queued",
      effect: "pending",
      executionReason: null,
      costBearer: { label: "Test operator" },
      acceptedAt: "2026-08-30T02:00:00.000Z",
      lastObservedAt: null,
      effectEvidence: null,
      updatedAt: "2026-08-30T02:00:00.000Z",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open Local orchestrator thread" }));
    await waitFor(() => expect(runtimeApi.getAgentRuntimeConnections).toHaveBeenCalled());
    await submitDispatch("local dispatch");
    await waitFor(() => expect(pending.has(local.id)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Multiplayer" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await submitDispatch("shared dispatch");
    await waitFor(() => expect(pending.has(shared.id)).toBe(true));
    expect(screen.getByRole("button", { name: "Dispatching…" })).toBeDisabled();

    await act(async () => {
      pending.get(local.id)?.(receipt("local-receipt"));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Dispatching…" })).toBeDisabled();

    act(() => pending.get(shared.id)?.(receipt("shared-receipt")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve a public effect" })).toBeVisible(),
    );
  });
});
