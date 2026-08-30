import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Layers3, X } from "lucide-react";
import type {
  ClusterNavigation,
  ProjectedThreadAnchor,
  ThreadOffscreenLocator,
  ThreadPanelPlacement,
  ThreadVisualCluster,
} from "./orchestratorThreadGeometry";
import "./OrchestratorThreadOverlay.css";

export type OrchestratorThreadSurface = {
  readonly anchors: readonly ProjectedThreadAnchor[];
  readonly clusters: readonly ThreadVisualCluster[];
  readonly offscreenLocators: readonly ThreadOffscreenLocator[];
  readonly showInvitation: boolean;
  readonly active: {
    readonly anchor: ProjectedThreadAnchor;
    readonly placement: ThreadPanelPlacement;
  } | null;
  readonly backpressure: {
    readonly blocked: boolean;
    readonly occupiedRatio: number;
    readonly message: string | null;
  };
};

const directionIcon = (direction: ThreadPanelPlacement["direction"]) => {
  if (direction === "left") return <ArrowLeft size={15} />;
  if (direction === "right") return <ArrowRight size={15} />;
  if (direction === "up") return <ArrowUp size={15} />;
  if (direction === "down") return <ArrowDown size={15} />;
  return null;
};

export const OrchestratorThreadOverlay = ({
  surface,
  onOpen,
  onCreate,
  onClose,
  onJump,
  onClusterNavigate,
}: {
  readonly surface: OrchestratorThreadSurface;
  readonly onCreate: () => void;
  readonly onOpen: (threadId: string) => void;
  readonly onClose: () => void;
  readonly onJump: (threadId: string) => void;
  readonly onClusterNavigate: (action: ClusterNavigation) => void;
}) => {
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  const byThreadId = useMemo(
    () => new Map(surface.anchors.map((item) => [item.threadId, item] as const)),
    [surface.anchors],
  );

  useEffect(() => {
    if (
      expandedClusterId &&
      !surface.clusters.some((cluster) => cluster.id === expandedClusterId) &&
      !surface.offscreenLocators.some((locator) => locator.id === expandedClusterId)
    ) {
      setExpandedClusterId(null);
    }
  }, [expandedClusterId, surface.clusters, surface.offscreenLocators]);

  return (
    <div className="orchestrator-thread-layer" data-testid="orchestrator-thread-layer">
      {surface.showInvitation ? (
        <section
          className="orchestrator-thread-invitation"
          aria-labelledby="orchestrator-thread-invitation-title"
          data-testid="orchestrator-thread-invitation"
        >
          <span className="orchestrator-thread-invitation__eyebrow">
            <Bot size={16} /> Orchestrator thread
          </span>
          <h2 id="orchestrator-thread-invitation-title">Where should we coordinate?</h2>
          <p>
            Give the work a shared address in this part of the board. The thread stays here as
            Contexts, decisions and results appear around it.
          </p>
          <div className="orchestrator-thread-invitation__artifacts" aria-label="Board artifacts">
            <span>Context</span>
            <span>Decision</span>
            <span>Result</span>
          </div>
          <button type="button" onClick={onCreate}>
            Place thread here
          </button>
          <small>Messages and dispatch are added only through their explicit contracts.</small>
        </section>
      ) : null}

      {surface.clusters.map((cluster) => {
        if (cluster.memberThreadIds.length === 1) {
          const item = byThreadId.get(cluster.memberThreadIds[0]!);
          if (!item) return null;
          const width = Math.max(0, item.rect.right - item.rect.left);
          const height = Math.max(0, item.rect.bottom - item.rect.top);
          return (
            <div
              key={cluster.id}
              className="orchestrator-thread-card"
              style={{
                left: item.rect.left,
                top: item.rect.top,
                width,
                height,
                fontSize: Math.max(1, width / 17),
              }}
              data-testid="orchestrator-thread-card"
              data-thread-id={item.threadId}
            >
              <span className="orchestrator-thread-card__eyebrow">
                <Bot aria-hidden="true" /> Orchestrator
              </span>
              <strong>{item.title}</strong>
              <span>Closed · open at this anchor</span>
              <button
                type="button"
                className="orchestrator-thread-card__open"
                onClick={() => onOpen(item.threadId)}
                aria-label={`Open ${item.title}`}
              >
                Open
              </button>
            </div>
          );
        }

        const centreX = (cluster.rect.left + cluster.rect.right) / 2;
        const centreY = (cluster.rect.top + cluster.rect.bottom) / 2;
        const expanded = expandedClusterId === cluster.id;
        return (
          <div
            key={cluster.id}
            className="orchestrator-thread-cluster"
            style={{ left: centreX, top: centreY }}
            data-testid="orchestrator-thread-cluster"
          >
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedClusterId(expanded ? null : cluster.id)}
            >
              <Layers3 size={15} /> {cluster.memberThreadIds.length} threads
            </button>
            {expanded ? (
              <div className="orchestrator-thread-cluster__members" role="menu">
                {cluster.memberThreadIds.map((threadId) => {
                  const item = byThreadId.get(threadId);
                  if (!item) return null;
                  return (
                    <button
                      key={threadId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        // Navigation to exactly one original anchor is the
                        // cluster's entire action vocabulary. No Context,
                        // Dispatch or Lease action exists at this boundary.
                        onClusterNavigate({ kind: "navigate", threadId });
                        setExpandedClusterId(null);
                      }}
                    >
                      {item.title}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      {surface.offscreenLocators.map((locator) => {
        const expanded = expandedClusterId === locator.id;
        return (
          <div
            key={locator.id}
            className="orchestrator-thread-locator"
            style={{ left: locator.left, top: locator.top }}
            data-direction={locator.direction}
          >
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedClusterId(expanded ? null : locator.id)}
            >
              {directionIcon(locator.direction)}
              {locator.memberThreadIds.length === 1
                ? "1 thread"
                : `${locator.memberThreadIds.length} threads`}
            </button>
            {expanded ? (
              <div className="orchestrator-thread-locator__members" role="menu">
                {locator.memberThreadIds.map((threadId) => {
                  const item = byThreadId.get(threadId);
                  if (!item) return null;
                  return (
                    <button
                      key={threadId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onClusterNavigate({ kind: "navigate", threadId });
                        setExpandedClusterId(null);
                      }}
                    >
                      {item.title}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      {surface.backpressure.blocked ? (
        <div
          className="orchestrator-thread-backpressure"
          role="status"
          aria-live="polite"
          data-testid="orchestrator-thread-backpressure"
        >
          <strong>Board thread view is saturated</strong>
          <span>{surface.backpressure.message}</span>
          <small>
            {Math.round(surface.backpressure.occupiedRatio * 100)}% of the visible board is covered
            by thread anchors. Read-only work can continue.
          </small>
        </div>
      ) : null}

      {surface.active ? (
        <aside
          className={`orchestrator-thread-panel orchestrator-thread-panel--${surface.active.placement.mode}`}
          style={{
            left: surface.active.placement.panelRect.left,
            top: surface.active.placement.panelRect.top,
            width:
              surface.active.placement.panelRect.right - surface.active.placement.panelRect.left,
            height:
              surface.active.placement.panelRect.bottom - surface.active.placement.panelRect.top,
          }}
          aria-label="Orchestrator thread"
          data-testid="orchestrator-thread-panel"
          data-mode={surface.active.placement.mode}
        >
          <header>
            <div>
              <span className="orchestrator-thread-panel__eyebrow">
                <Bot size={14} /> Orchestrator thread
              </span>
              <strong>{surface.active.anchor.title}</strong>
            </div>
            <button type="button" onClick={onClose} aria-label="Close orchestrator thread">
              <X size={16} />
            </button>
          </header>

          {surface.active.placement.mode === "docked" ? (
            <button
              type="button"
              className="orchestrator-thread-panel__location"
              onClick={() => onJump(surface.active!.anchor.threadId)}
            >
              {directionIcon(surface.active.placement.direction)}
              Anchor outside the readable view
              {surface.active.placement.distance > 0
                ? ` · ${surface.active.placement.distance}px away`
                : ""}
              <span>Jump to anchor</span>
            </button>
          ) : (
            <div className="orchestrator-thread-panel__location orchestrator-thread-panel__location--anchored">
              <span className="orchestrator-thread-panel__pulse" /> Open at its readable Board Card
            </div>
          )}

          <div className="orchestrator-thread-panel__empty">
            <Layers3 size={24} />
            <strong>No orchestrator events yet</strong>
            <p>
              This shared anchor keeps the thread at the place it coordinates. Message audience,
              Dispatch and Lease effects arrive through their own contracts, never through visual
              proximity.
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
};
