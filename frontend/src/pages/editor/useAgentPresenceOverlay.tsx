import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import type { BoardAgentVisualSnapshot } from "./agentPresenceState";
import { AgentPresenceOverlay, type BoardAgentHighlightBox } from "./AgentPresenceOverlay";

const sameBoxes = (
  left: readonly BoardAgentHighlightBox[],
  right: readonly BoardAgentHighlightBox[],
): boolean =>
  left.length === right.length &&
  left.every((box, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      box.key === other.key &&
      box.targetId === other.targetId &&
      box.left === other.left &&
      box.top === other.top &&
      box.width === other.width &&
      box.height === other.height &&
      box.color === other.color &&
      box.opacity === other.opacity &&
      box.label === other.label &&
      box.labelOffset === other.labelOffset &&
      box.revisionId === other.revisionId
    );
  });

const statusLabel = (status: BoardAgentVisualSnapshot["status"]): string => {
  switch (status) {
    case "blocked":
      return "blocked";
    case "idle":
      return "reading";
    case "done":
      return "done";
    default:
      return "reading";
  }
};

export const useAgentPresenceOverlay = ({
  adapter,
  presence,
  enabled,
}: {
  adapter: ExcalidrawAdapter;
  presence: readonly BoardAgentVisualSnapshot[];
  /** Deployments without an agent runtime draw no agent highlight boxes. */
  enabled: boolean;
}): { agentPresenceOverlay: React.ReactNode } => {
  const [boxes, setBoxes] = useState<readonly BoardAgentHighlightBox[]>([]);

  useEffect(() => {
    // Not only the portal: without this the hook still subscribes to every
    // scene change and scroll frame to recompute boxes it will never render.
    if (!enabled) {
      setBoxes((current) => (current.length === 0 ? current : []));
      return;
    }
    const recompute = () => {
      const next: BoardAgentHighlightBox[] = [];
      const activeLabelsByTarget = new Map<string, number>();
      for (const run of presence) {
        const addTargets = (targetIds: readonly string[], opacity: number, active: boolean) => {
          for (const targetId of targetIds) {
            const summary = adapter.scene.summaryById(targetId as never);
            if (!summary.ok || !summary.value || summary.value.isDeleted) continue;
            const topLeft = adapter.viewport.toViewport({
              x: summary.value.x,
              y: summary.value.y,
            } as never);
            const bottomRight = adapter.viewport.toViewport({
              x: summary.value.x + summary.value.width,
              y: summary.value.y + summary.value.height,
            } as never);
            if (!topLeft.ok || !bottomRight.ok) continue;
            const labelOffset = active ? (activeLabelsByTarget.get(targetId) ?? 0) : 0;
            if (active) activeLabelsByTarget.set(targetId, labelOffset + 1);
            next.push({
              key: `${run.runId}:${active ? "active" : "trail"}:${targetId}`,
              targetId,
              left: Math.min(topLeft.value.x, bottomRight.value.x),
              top: Math.min(topLeft.value.y, bottomRight.value.y),
              width: Math.max(2, Math.abs(bottomRight.value.x - topLeft.value.x)),
              height: Math.max(2, Math.abs(bottomRight.value.y - topLeft.value.y)),
              color: run.color,
              opacity,
              label: active ? `${run.displayName} · ${statusLabel(run.status)}` : null,
              labelOffset,
              revisionId: run.revisionId,
            });
          }
        };
        addTargets(run.trailTargetIds, run.trailOpacity * 0.55, false);
        addTargets(run.activeTargetIds, 1, true);
      }
      setBoxes((current) => (sameBoxes(current, next) ? current : next));
    };

    recompute();
    const unsubscribeScene = adapter.scene.subscribe(recompute);
    const unsubscribeScroll = adapter.viewport.subscribeScroll(recompute);
    return () => {
      unsubscribeScene();
      unsubscribeScroll();
    };
  }, [adapter, enabled, presence]);

  const root = adapter.ui.overlayRoot();
  return {
    agentPresenceOverlay:
      enabled && root.ok ? createPortal(<AgentPresenceOverlay boxes={boxes} />, root.value) : null,
  };
};
