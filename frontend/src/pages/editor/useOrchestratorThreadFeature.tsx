import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
}: {
  readonly adapter: ExcalidrawAdapter;
  readonly canEdit: boolean;
  readonly isReady: boolean;
}) => {
  const [activeElementId, setActiveElementId] = useState<string | null>(null);
  const [surface, setSurface] = useState<OrchestratorThreadSurface>(emptySurface);
  const previousMode = useRef<ThreadPanelMode>("closed");
  const pendingCreatedElementId = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) {
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
        anchors.push({
          threadId: record.threadId,
          elementId: element.id,
          title: record.title,
          rect,
        });
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
  }, [activeElementId, adapter, canEdit, isReady]);

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

  const openThread = useCallback((elementId: string) => {
    previousMode.current = "closed";
    setActiveElementId((current) => selectOpenThread(current, elementId));
  }, []);

  const jumpToThread = useCallback(
    (elementId: string) => {
      const anchor = surface.anchors.find((item) => item.elementId === elementId);
      if (!anchor) return;
      adapter.viewport.scrollToElement(anchor.elementId as ElementId);
    },
    [adapter, surface.anchors],
  );

  const root = adapter.ui.overlayRoot();
  return {
    createThread,
    orchestratorThreadOverlay: root.ok
      ? createPortal(
          <OrchestratorThreadOverlay
            surface={surface}
            onCreate={createThread}
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
