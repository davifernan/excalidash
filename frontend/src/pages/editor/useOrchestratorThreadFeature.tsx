import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { Socket } from "socket.io-client";
import {
  appendOrchestratorThreadMessage,
  createPublicDispatch,
  getOrCreateLocalOrchestratorThread,
  getOrchestratorThreadEvents,
  getOrchestratorThreads,
  getPublicDispatchReceipts,
  registerSharedOrchestratorThread,
  type AgentThreadEventDTO,
  type PublicDispatchReceipt,
  type OrchestratorThreadDTO,
} from "../../api/orchestratorThreads";
import { getAgentRuntimeConnections, type AgentRuntimeConnection } from "../../api/agentRuntime";
import { getInstructionContexts, type InstructionContext } from "../../api/instructionApprovals";
import {
  readOrchestratorThreadAnchor,
  withExcalidashData,
} from "../../integrations/excalidraw/customData";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import { buildElements } from "../../integrations/excalidraw/elements";
import { findFloatingToolbarObstacleElements } from "../../integrations/excalidraw/domBridge";
import type { ElementId, ElementSummary, NewElement } from "../../integrations/excalidraw/types";
import { notify } from "../../notifications";
import {
  activateClusterMember,
  clusterThreadAnchors,
  computeOffscreenThreadLocators,
  computeCoordinationBackpressure,
  resolveOpenThreadPanel,
  isThreadAnchorOffscreen,
  selectOpenThread,
  type ProjectedThreadAnchor,
  type ScreenRect,
  type ThreadPanelMode,
} from "./orchestratorThreadGeometry";
import {
  OrchestratorThreadOverlay,
  type OrchestratorThreadSurface,
} from "./OrchestratorThreadOverlay";

const CARD_WIDTH = 260;
const CARD_HEIGHT = 156;
const MAX_SHARED_THREAD_REGISTRATION_ATTEMPTS = 4;
const privateElementId = (threadId: string) => `private-thread:${threadId}`;

const projectRect = (adapter: ExcalidrawAdapter, element: ElementSummary): ScreenRect | null => {
  const centre = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
  const cos = Math.cos(element.angle);
  const sin = Math.sin(element.angle);
  const rotate = (point: { readonly x: number; readonly y: number }) => ({
    x: centre.x + (point.x - centre.x) * cos - (point.y - centre.y) * sin,
    y: centre.y + (point.x - centre.x) * sin + (point.y - centre.y) * cos,
  });
  const corners = [
    { x: element.x, y: element.y },
    { x: element.x + element.width, y: element.y },
    { x: element.x, y: element.y + element.height },
    { x: element.x + element.width, y: element.y + element.height },
  ]
    .map(rotate)
    .map((point) => adapter.viewport.toViewport(point))
    .filter((result) => result.ok)
    .map((result) => (result as { ok: true; value: { x: number; y: number } }).value);
  if (corners.length !== 4) return null;
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
};

const emptySurface: OrchestratorThreadSurface = {
  anchors: [],
  clusters: [],
  offscreenLocators: [],
  showInvitation: false,
  active: null,
  backpressure: { blocked: false, occupiedRatio: 0, message: null },
};

const mergeReceiptLists = (
  current: readonly PublicDispatchReceipt[],
  incoming: readonly PublicDispatchReceipt[],
): PublicDispatchReceipt[] => {
  const byId = new Map(current.map((receipt) => [receipt.id, receipt] as const));
  let changed = false;
  for (const receipt of incoming) {
    const existing = byId.get(receipt.id);
    if (!existing || Date.parse(receipt.updatedAt) >= Date.parse(existing.updatedAt)) {
      if (existing !== receipt) changed = true;
      byId.set(receipt.id, receipt);
    }
  }
  if (!changed) return current as PublicDispatchReceipt[];
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt) || left.id.localeCompare(right.id),
  );
};

const sameRect = (left: ScreenRect, right: ScreenRect) =>
  left.left === right.left &&
  left.top === right.top &&
  left.right === right.right &&
  left.bottom === right.bottom;

const sameReferences = (
  left: readonly { readonly threadId: string; readonly elementId: string }[],
  right: readonly { readonly threadId: string; readonly elementId: string }[],
) =>
  left.length === right.length &&
  left.every(
    (value, index) =>
      value.threadId === right[index]?.threadId && value.elementId === right[index]?.elementId,
  );

const sameAnchor = (left: ProjectedThreadAnchor, right: ProjectedThreadAnchor) =>
  left.threadId === right.threadId &&
  left.elementId === right.elementId &&
  left.title === right.title &&
  sameRect(left.rect, right.rect);

/**
 * Excalidraw's scene event fires for every editor change, including document
 * pagination and drawing gestures that do not alter a thread surface. Keep
 * that subscription broad enough to discover a newly inserted Board Card,
 * but do not turn each unrelated event into another React render.
 */
const sameSurface = (left: OrchestratorThreadSurface, right: OrchestratorThreadSurface) =>
  left.showInvitation === right.showInvitation &&
  left.anchors.length === right.anchors.length &&
  left.anchors.every((anchor, index) => sameAnchor(anchor, right.anchors[index]!)) &&
  left.clusters.length === right.clusters.length &&
  left.clusters.every((cluster, index) => {
    const candidate = right.clusters[index]!;
    return (
      cluster.id === candidate.id &&
      sameReferences(cluster.members, candidate.members) &&
      sameRect(cluster.rect, candidate.rect)
    );
  }) &&
  left.offscreenLocators.length === right.offscreenLocators.length &&
  left.offscreenLocators.every((locator, index) => {
    const candidate = right.offscreenLocators[index]!;
    return (
      locator.id === candidate.id &&
      locator.direction === candidate.direction &&
      sameReferences(locator.members, candidate.members) &&
      locator.left === candidate.left &&
      locator.top === candidate.top
    );
  }) &&
  (left.active === null
    ? right.active === null
    : right.active !== null &&
      sameAnchor(left.active.anchor, right.active.anchor) &&
      left.active.placement.mode === right.active.placement.mode &&
      sameRect(left.active.placement.panelRect, right.active.placement.panelRect) &&
      left.active.placement.direction === right.active.placement.direction &&
      left.active.placement.distance === right.active.placement.distance) &&
  left.backpressure.blocked === right.backpressure.blocked &&
  left.backpressure.occupiedRatio === right.backpressure.occupiedRatio &&
  left.backpressure.message === right.backpressure.message;

/**
 * Shared state is the Board Card itself. The one-open-panel choice, cluster
 * expansion and dock/anchor stage are intentionally local view state: sharing
 * them would make one person's camera or attention move everybody else's.
 */
export const useOrchestratorThreadFeature = ({
  adapter,
  canEdit,
  isReady,
  drawingId,
  socketRef,
  currentUserId,
  enabled,
}: {
  readonly adapter: ExcalidrawAdapter;
  readonly canEdit: boolean;
  readonly isReady: boolean;
  readonly drawingId?: string;
  readonly socketRef?: MutableRefObject<Socket | null>;
  readonly currentUserId?: string | null;
  /**
   * Deployments without an agent runtime render no board threads and issue no
   * thread requests. Gating the effects too, not just the overlay, keeps a
   * disabled instance from polling endpoints whose results it would discard.
   */
  readonly enabled: boolean;
}) => {
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  const [surface, setSurface] = useState<OrchestratorThreadSurface>(emptySurface);
  const [threads, setThreads] = useState<OrchestratorThreadDTO[]>([]);
  const [eventsByThread, setEventsByThread] = useState<Record<string, AgentThreadEventDTO[]>>({});
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [sendingThreadIds, setSendingThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [threadError, setThreadError] = useState<string | null>(null);
  const [actionErrorsByThread, setActionErrorsByThread] = useState<Record<string, string | null>>(
    {},
  );
  const [receiptsByThread, setReceiptsByThread] = useState<Record<string, PublicDispatchReceipt[]>>(
    {},
  );
  const [dispatchContexts, setDispatchContexts] = useState<InstructionContext[]>([]);
  const [dispatchConnections, setDispatchConnections] = useState<AgentRuntimeConnection[]>([]);
  const [dispatchingThreadIds, setDispatchingThreadIds] = useState<ReadonlySet<string>>(new Set());
  const previousMode = useRef<ThreadPanelMode>("closed");
  const pendingCreatedElementId = useRef<string | null>(null);
  const requestedThreadIds = useRef(new Set<string>());
  const lastDrawingThreadId = useRef<string | null>(null);
  const pendingMessageThreadIds = useRef(new Set<string>());
  const pendingDispatchThreadIds = useRef(new Set<string>());
  const sharedRegistrationAttempts = useRef(new Map<string, number>());
  const failedSharedRegistrationIds = useRef(new Set<string>());

  const upsertThread = useCallback((incoming: OrchestratorThreadDTO) => {
    setThreads((current) => {
      const index = current.findIndex((thread) => thread.id === incoming.id);
      if (index < 0) return [...current, incoming];
      const next = [...current];
      next[index] = incoming;
      return next;
    });
  }, []);

  useEffect(() => {
    // Editor can move between route ids without a full page reload. No local
    // cache, open identity or already-requested marker may cross that Board
    // boundary even though thread ids are globally generated.
    setActiveElementId(null);
    setEventsByThread({});
    setLoadingThreadId(null);
    setSendingThreadIds(new Set());
    setThreadError(null);
    setActionErrorsByThread({});
    setReceiptsByThread({});
    setDispatchContexts([]);
    setDispatchConnections([]);
    setDispatchingThreadIds(new Set());
    pendingMessageThreadIds.current.clear();
    pendingDispatchThreadIds.current.clear();
    sharedRegistrationAttempts.current.clear();
    failedSharedRegistrationIds.current.clear();
    requestedThreadIds.current.clear();
    lastDrawingThreadId.current = null;
    previousMode.current = "closed";
  }, [drawingId]);

  useEffect(() => {
    if (!enabled || !drawingId || !isReady) {
      setThreads([]);
      return;
    }
    let cancelled = false;
    void getOrchestratorThreads(drawingId)
      .then((loaded) => {
        if (!cancelled) setThreads(loaded);
      })
      .catch(() => {
        if (!cancelled) setThreadError("Thread audiences could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [drawingId, enabled, isReady]);

  useEffect(() => {
    const socket = socketRef?.current;
    if (!enabled || !socket || !drawingId) return;
    const onThread = (thread: OrchestratorThreadDTO) => {
      if (thread.drawingId === drawingId) upsertThread(thread);
    };
    const onEvent = (payload: { threadId: string; event: AgentThreadEventDTO }) => {
      setEventsByThread((current) => {
        const existing = current[payload.threadId] ?? [];
        if (existing.some((event) => event.id === payload.event.id)) return current;
        return { ...current, [payload.threadId]: [...existing, payload.event] };
      });
    };
    const onReceipt = (receipt: PublicDispatchReceipt) => {
      if (receipt.drawingId !== drawingId) return;
      setReceiptsByThread((current) => {
        const existing = current[receipt.publicThreadId] ?? [];
        const merged = mergeReceiptLists(existing, [receipt]);
        return merged === existing ? current : { ...current, [receipt.publicThreadId]: merged };
      });
    };
    socket.on("agent.thread.updated", onThread);
    socket.on("agent.thread.event.appended", onEvent);
    socket.on("agent.dispatch.receipt.updated", onReceipt);
    return () => {
      socket.off("agent.thread.updated", onThread);
      socket.off("agent.thread.event.appended", onEvent);
      socket.off("agent.dispatch.receipt.updated", onReceipt);
    };
  }, [drawingId, enabled, socketRef, upsertThread]);

  // Registration waits for the ordinary autosave path to persist the Board
  // Card. Retries cover that bounded window; a permanent rejection stops and
  // becomes visible instead of silently polling for the rest of the session.
  // Raw client customData never becomes shared authority: only the server's
  // persisted card can create the drawing-audience thread.
  useEffect(() => {
    if (!enabled || !drawingId || !canEdit || !isReady) return;
    let cancelled = false;
    let busy = false;
    const reconcile = async () => {
      if (busy) return;
      busy = true;
      try {
        const summaries = adapter.scene.summaries();
        if (!summaries.ok) return;
        const registered = new Set(
          threads
            .filter((thread) => thread.anchor.kind === "drawing")
            .map((thread) => (thread.anchor.kind === "drawing" ? thread.anchor.elementId : "")),
        );
        for (const element of summaries.value) {
          if (cancelled || element.isDeleted || registered.has(element.id)) continue;
          if (failedSharedRegistrationIds.current.has(element.id)) continue;
          if (!readOrchestratorThreadAnchor({ customData: element.customData })) continue;
          try {
            const thread = await registerSharedOrchestratorThread(drawingId, element.id);
            sharedRegistrationAttempts.current.delete(element.id);
            if (!cancelled) upsertThread(thread);
          } catch {
            const attempts = (sharedRegistrationAttempts.current.get(element.id) ?? 0) + 1;
            sharedRegistrationAttempts.current.set(element.id, attempts);
            if (attempts >= MAX_SHARED_THREAD_REGISTRATION_ATTEMPTS) {
              failedSharedRegistrationIds.current.add(element.id);
              notify("error", "A shared thread card could not be registered.", {
                key: "orchestrator-thread-registration:" + element.id,
                detail:
                  "The server rejected the card after the autosave window. Reload after correcting or replacing it.",
              });
            }
          }
        }
      } finally {
        busy = false;
      }
    };
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [adapter, canEdit, drawingId, enabled, isReady, threads, upsertThread]);

  useEffect(() => {
    if (!enabled || !isReady) {
      setSurface(emptySurface);
      return;
    }
    let raf: number | null = null;
    const recompute = () => {
      raf = null;
      const summaries = adapter.scene.summaries();
      const viewport = adapter.viewport.read();
      if (!summaries.ok || !viewport.ok) {
        setSurface(emptySurface);
        return;
      }

      const anchors: ProjectedThreadAnchor[] = [];
      let hasBoardContent = false;
      for (const element of summaries.value) {
        if (element.isDeleted) continue;
        hasBoardContent = true;
        const record = readOrchestratorThreadAnchor({ customData: element.customData });
        if (!record) continue;
        const rect = projectRect(adapter, element);
        if (!rect) continue;
        const registered = threads.find(
          (thread) => thread.anchor.kind === "drawing" && thread.anchor.elementId === element.id,
        );
        anchors.push({
          // customData.threadId survives duplicate/copy-paste and therefore
          // cannot address server history. Until registration succeeds it is
          // display-only; the element id is the unique Board address.
          threadId: registered?.id ?? `unregistered:${element.id}`,
          elementId: element.id,
          title: registered?.title ?? record.title,
          rect,
        });
      }

      const privateThread = threads.find(
        (thread) => thread.audience.kind === "private" && thread.anchor.kind === "private",
      );
      if (privateThread?.anchor.kind === "private") {
        const projected = adapter.viewport.toViewport({
          x: privateThread.anchor.x,
          y: privateThread.anchor.y,
        });
        if (projected.ok) {
          anchors.push({
            threadId: privateThread.id,
            elementId: privateElementId(privateThread.id),
            title: privateThread.title,
            rect: {
              left: projected.value.x - 90,
              top: projected.value.y - 30,
              right: projected.value.x + 90,
              bottom: projected.value.y + 30,
            },
          });
        }
      }

      const activeAnchor = activeElementId
        ? (anchors.find((item) => item.elementId === activeElementId) ?? null)
        : null;
      if (activeAnchor && pendingCreatedElementId.current === activeElementId) {
        pendingCreatedElementId.current = null;
      }
      if (activeElementId && !activeAnchor && pendingCreatedElementId.current !== activeElementId) {
        previousMode.current = "closed";
        setActiveElementId(null);
      }
      const active = activeAnchor
        ? {
            anchor: activeAnchor,
            placement: resolveOpenThreadPanel({
              anchor: activeAnchor,
              viewport: viewport.value,
              previousMode: previousMode.current,
              obstacles: (() => {
                const root = adapter.ui.overlayRoot();
                if (!root.ok) return [];
                const rootRect = root.value.getBoundingClientRect();
                return findFloatingToolbarObstacleElements(root.value).map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    left: rect.left - rootRect.left,
                    top: rect.top - rootRect.top,
                    right: rect.right - rootRect.left,
                    bottom: rect.bottom - rootRect.top,
                  };
                });
              })(),
            }),
          }
        : null;
      previousMode.current = active?.placement.mode ?? "closed";

      const closedAnchors = activeAnchor
        ? anchors.filter((item) => item.elementId !== activeAnchor.elementId)
        : anchors;
      const nextSurface: OrchestratorThreadSurface = {
        anchors,
        clusters: clusterThreadAnchors(
          closedAnchors.filter((item) => !isThreadAnchorOffscreen(item, viewport.value)),
        ),
        offscreenLocators: computeOffscreenThreadLocators(closedAnchors, viewport.value),
        // The large invitation is deliberately the empty-board state. On a
        // populated board without a thread it would cover somebody's work;
        // creation remains available through the explicit main-menu command.
        showInvitation: canEdit && !hasBoardContent,
        active,
        backpressure: computeCoordinationBackpressure(anchors, viewport.value),
      };
      setSurface((current) => (sameSurface(current, nextSurface) ? current : nextSurface));
    };
    const schedule = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(recompute);
    };
    schedule();
    const unsubscribeScene = adapter.scene.subscribe(schedule);
    const unsubscribeScroll = adapter.viewport.subscribeScroll(schedule);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      unsubscribeScene();
      unsubscribeScroll();
    };
  }, [activeElementId, adapter, canEdit, enabled, isReady, threads]);

  const createThread = useCallback(() => {
    if (!canEdit || !isReady) return;
    const viewport = adapter.viewport.read();
    if (!viewport.ok) {
      notify("error", "The board is not ready for a thread anchor.");
      return;
    }
    const at = adapter.viewport.toScene({
      x: viewport.value.width / 2,
      y: viewport.value.height / 2,
    });
    if (!at.ok) {
      notify("error", "The board is not ready for a thread anchor.");
      return;
    }
    const threadId = crypto.randomUUID();
    const elementId = threadId as ElementId;
    const title = `Orchestrator ${threadId.slice(0, 4)}`;
    const customData = withExcalidashData(
      {},
      {
        orchestratorThread: {
          threadId,
          title,
        },
      },
    );
    // `scene.apply` ultimately calls updateScene; it does not fill a shape
    // skeleton's required groupIds/seed/version fields. Build the complete
    // Excalidraw element first, just as every other non-trivial insertion at
    // this seam does. A raw object renders once and then crashes the
    // InteractiveCanvas when selection asks for its missing groupIds.
    const built = buildElements(
      [
        {
          id: elementId,
          type: "rectangle",
          x: at.value.x - CARD_WIDTH / 2,
          y: at.value.y - CARD_HEIGHT / 2,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          backgroundColor: "#e9e3ff",
          strokeColor: "#6d5bd0",
          fillStyle: "solid",
          roughness: 0,
          roundness: { type: 3 },
          customData,
        },
      ],
      { regenerateIds: false },
    ) as unknown as NewElement[];
    pendingCreatedElementId.current = elementId;
    const result = adapter.scene.apply(
      [
        {
          kind: "insert",
          elements: built,
        },
        { kind: "select", ids: [elementId] },
      ],
      { capture: "immediate" },
    );
    if (!result.ok) {
      pendingCreatedElementId.current = null;
      notify("error", "The thread anchor could not be placed.");
      return;
    }
    previousMode.current = "closed";
    setActiveElementId(elementId);
  }, [adapter, canEdit, isReady]);

  const createLocalThread = useCallback(async () => {
    if (!drawingId || !currentUserId || !isReady) {
      notify("error", "Sign in to start a local orchestrator thread.");
      return;
    }
    const viewport = adapter.viewport.read();
    if (!viewport.ok) return;
    const at = adapter.viewport.toScene({
      x: viewport.value.width / 2,
      y: viewport.value.height / 2,
    });
    if (!at.ok) return;
    try {
      const thread = await getOrCreateLocalOrchestratorThread(drawingId, at.value);
      upsertThread(thread);
      previousMode.current = "closed";
      setActiveElementId(privateElementId(thread.id));
    } catch {
      notify("error", "The local thread could not be opened.");
    }
  }, [adapter, currentUserId, drawingId, isReady, upsertThread]);

  const openThread = useCallback((elementId: string) => {
    previousMode.current = "closed";
    setActiveElementId((current) => selectOpenThread(current, elementId));
  }, []);

  const activeThread = useMemo(
    () =>
      surface.active
        ? (threads.find((thread) => thread.id === surface.active!.anchor.threadId) ?? null)
        : null,
    [surface.active, threads],
  );

  useEffect(() => {
    // Loading/action failures describe the panel that initiated them. Cached
    // histories do not start a new fetch that could otherwise clear a stale
    // error after the user switches to a different thread.
    setThreadError(null);
  }, [activeThread?.id]);

  const publicThreads = useMemo(
    () => threads.filter((thread) => thread.audience.kind === "drawing"),
    [threads],
  );
  const receiptThreads = useMemo(
    // A shared panel shows its anchored responsibility. A private panel has
    // no public receipt history of its own, so it explicitly presents the
    // Board-wide public-effect ledger without exposing private origin ids.
    () =>
      activeThread?.audience.kind === "drawing"
        ? [activeThread]
        : activeThread
          ? publicThreads
          : [],
    [activeThread, publicThreads],
  );

  useEffect(() => {
    if (!drawingId || !activeThread || receiptThreads.length === 0) return;
    let cancelled = false;
    void Promise.all(
      receiptThreads.map(async (thread) => ({
        threadId: thread.id,
        receipts: await getPublicDispatchReceipts(drawingId, thread.id),
      })),
    )
      .then((snapshots) => {
        if (cancelled) return;
        setReceiptsByThread((current) => {
          let changed = false;
          const next = { ...current };
          for (const snapshot of snapshots) {
            const existing = current[snapshot.threadId] ?? [];
            const merged = mergeReceiptLists(existing, snapshot.receipts);
            if (merged !== existing) {
              next[snapshot.threadId] = merged;
              changed = true;
            }
          }
          return changed ? next : current;
        });
      })
      .catch(() => {
        if (!cancelled) setThreadError("Public dispatch receipts could not be loaded.");
      });
    if (canEdit) {
      void Promise.all([getInstructionContexts(drawingId), getAgentRuntimeConnections(drawingId)])
        .then(([contexts, connections]) => {
          if (cancelled) return;
          setDispatchContexts(contexts);
          setDispatchConnections(connections);
        })
        .catch(() => {
          if (!cancelled) setThreadError("Public dispatch options could not be loaded.");
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeThread, canEdit, drawingId, receiptThreads]);

  useEffect(() => {
    if (activeThread?.audience.kind === "drawing") {
      lastDrawingThreadId.current = activeThread.id;
    }
  }, [activeThread]);

  useEffect(() => {
    if (
      !drawingId ||
      !activeThread ||
      eventsByThread[activeThread.id] ||
      requestedThreadIds.current.has(activeThread.id)
    ) {
      return;
    }
    let cancelled = false;
    requestedThreadIds.current.add(activeThread.id);
    setLoadingThreadId(activeThread.id);
    setThreadError(null);
    void getOrchestratorThreadEvents(drawingId, activeThread.id)
      .then((events) => {
        if (!cancelled) setEventsByThread((current) => ({ ...current, [activeThread.id]: events }));
      })
      .catch(() => {
        if (!cancelled) setThreadError("This thread history could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoadingThreadId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThread, drawingId, eventsByThread]);

  const switchAudience = useCallback(
    (audience: "private" | "drawing") => {
      const target =
        audience === "drawing"
          ? (threads.find((thread) => thread.id === lastDrawingThreadId.current) ??
            threads.find((thread) => thread.audience.kind === "drawing"))
          : threads.find((thread) => thread.audience.kind === "private");
      if (!target) {
        if (audience === "private") void createLocalThread();
        else if (canEdit) createThread();
        return;
      }
      const elementId =
        target.anchor.kind === "private" ? privateElementId(target.id) : target.anchor.elementId;
      previousMode.current = "closed";
      setActiveElementId(elementId);
    },
    [canEdit, createLocalThread, createThread, threads],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!drawingId || !activeThread) throw new Error("No active thread");
      const threadId = activeThread.id;
      if (pendingMessageThreadIds.current.has(threadId)) throw new Error("Message already pending");
      pendingMessageThreadIds.current.add(threadId);
      setSendingThreadIds((current) => new Set(current).add(threadId));
      setActionErrorsByThread((current) => ({ ...current, [threadId]: null }));
      try {
        const event = await appendOrchestratorThreadMessage(drawingId, threadId, text);
        setEventsByThread((current) => {
          const existing = current[threadId] ?? [];
          return existing.some((candidate) => candidate.id === event.id)
            ? current
            : { ...current, [threadId]: [...existing, event] };
        });
      } catch (error) {
        setActionErrorsByThread((current) => ({
          ...current,
          [threadId]: "The message was not accepted. Nothing was published.",
        }));
        throw error;
      } finally {
        pendingMessageThreadIds.current.delete(threadId);
        setSendingThreadIds((current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
      }
    },
    [activeThread, drawingId],
  );

  const dispatchPublicEffect = useCallback(
    async (input: {
      publicThreadId: string;
      objectiveSummary: string;
      targetContextId: string;
      connectionId: string;
      profileId: string;
    }) => {
      const publicThread = publicThreads.find((thread) => thread.id === input.publicThreadId);
      if (!drawingId || !activeThread || !publicThread || surface.backpressure.blocked)
        throw new Error("Public dispatch is unavailable");
      const originThreadId = activeThread.id;
      const publicThreadId = publicThread.id;
      if (pendingDispatchThreadIds.current.has(originThreadId)) {
        throw new Error("Dispatch already pending");
      }
      pendingDispatchThreadIds.current.add(originThreadId);
      setDispatchingThreadIds((current) => new Set(current).add(originThreadId));
      setActionErrorsByThread((current) => ({ ...current, [originThreadId]: null }));
      try {
        const receipt = await createPublicDispatch(drawingId, originThreadId, {
          publicThreadId,
          objectiveSummary: input.objectiveSummary,
          targetContextIds: [input.targetContextId],
          connectionId: input.connectionId,
          profileId: input.profileId,
          displayName: "Board orchestrator",
        });
        setReceiptsByThread((current) => ({
          ...current,
          [publicThreadId]: mergeReceiptLists(current[publicThreadId] ?? [], [receipt]),
        }));
      } catch (error) {
        setActionErrorsByThread((current) => ({
          ...current,
          [originThreadId]: "The public dispatch was not accepted. No public work started.",
        }));
        throw error;
      } finally {
        pendingDispatchThreadIds.current.delete(originThreadId);
        setDispatchingThreadIds((current) => {
          const next = new Set(current);
          next.delete(originThreadId);
          return next;
        });
      }
    },
    [activeThread, drawingId, publicThreads, surface.backpressure.blocked],
  );

  const jumpToThread = useCallback(
    (elementId: string) => {
      const anchor = surface.anchors.find((item) => item.elementId === elementId);
      if (!anchor) return;
      const thread = threads.find((candidate) => candidate.id === anchor.threadId);
      if (thread?.anchor.kind === "private") {
        adapter.viewport.showBounds(
          [
            thread.anchor.x - 120,
            thread.anchor.y - 80,
            thread.anchor.x + 120,
            thread.anchor.y + 80,
          ],
          { animate: true },
        );
        return;
      }
      adapter.viewport.scrollToElement(anchor.elementId as ElementId);
    },
    [adapter, surface.anchors, threads],
  );

  const root = adapter.ui.overlayRoot();
  return {
    createThread,
    orchestratorThreadOverlay:
      enabled && root.ok
        ? createPortal(
            <OrchestratorThreadOverlay
              key={activeThread?.id ?? "closed"}
              surface={surface}
              onCreate={createThread}
              onCreateLocal={
                drawingId && currentUserId ? () => void createLocalThread() : undefined
              }
              panelView={
                activeThread
                  ? {
                      threadId: activeThread.id,
                      audience: activeThread.audience.kind,
                      events: eventsByThread[activeThread.id] ?? [],
                      loading: loadingThreadId === activeThread.id,
                      sending: sendingThreadIds.has(activeThread.id),
                      canWrite:
                        Boolean(currentUserId) &&
                        (activeThread.audience.kind === "private" || canEdit),
                      error: actionErrorsByThread[activeThread.id] ?? threadError,
                      publicThreads: publicThreads.map((thread) => ({
                        id: thread.id,
                        title: thread.title,
                      })),
                      receipts: receiptThreads.flatMap(
                        (thread) => receiptsByThread[thread.id] ?? [],
                      ),
                      dispatch:
                        publicThreads.length > 0 && canEdit
                          ? {
                              contexts: dispatchContexts,
                              connections: dispatchConnections,
                              submitting: dispatchingThreadIds.has(activeThread.id),
                              blocked: surface.backpressure.blocked,
                            }
                          : null,
                    }
                  : null
              }
              onSwitchAudience={switchAudience}
              onSendMessage={sendMessage}
              onDispatch={dispatchPublicEffect}
              onOpen={openThread}
              onClose={() => {
                previousMode.current = "closed";
                setActiveElementId(null);
              }}
              onJump={jumpToThread}
              onClusterNavigate={(action) => {
                const cluster = surface.clusters.find((candidate) =>
                  candidate.members.some((member) => member.elementId === action.elementId),
                );
                const locator = surface.offscreenLocators.find((candidate) =>
                  candidate.members.some((member) => member.elementId === action.elementId),
                );
                if (
                  (!cluster || !activateClusterMember(cluster, action.elementId)) &&
                  !locator?.members.some((member) => member.elementId === action.elementId)
                ) {
                  return;
                }
                jumpToThread(action.elementId);
                openThread(action.elementId);
              }}
            />,
            root.value,
          )
        : null,
  };
};
