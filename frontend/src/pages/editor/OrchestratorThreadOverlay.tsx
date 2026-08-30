import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Layers3,
  Lock,
  Send,
  Users,
  X,
} from "lucide-react";
import type { AgentThreadEventDTO } from "../../api/orchestratorThreads";
import type { PublicDispatchReceipt } from "../../api/orchestratorThreads";
import type { AgentRuntimeConnection } from "../../api/agentRuntime";
import type { InstructionContext } from "../../api/instructionApprovals";
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

export type OrchestratorThreadPanelView = {
  readonly threadId: string;
  readonly audience: "private" | "drawing";
  readonly events: readonly AgentThreadEventDTO[];
  readonly loading: boolean;
  readonly sending: boolean;
  readonly canWrite: boolean;
  readonly error: string | null;
  readonly receipts: readonly PublicDispatchReceipt[];
  readonly dispatch: {
    readonly publicThreadId: string;
    readonly contexts: readonly InstructionContext[];
    readonly connections: readonly AgentRuntimeConnection[];
    readonly submitting: boolean;
    readonly blocked: boolean;
  } | null;
};

const receiptLabel = (receipt: PublicDispatchReceipt): string => {
  if (receipt.effect === "committed") return "Effect confirmed on the board";
  if (["failed", "rejected"].includes(receipt.effect)) {
    return "Board effect failed · publication not completed";
  }
  if (receipt.execution === "outcome_unknown") return "Outcome unknown · runtime not observable";
  if (["failed", "cancelled"].includes(receipt.execution)) return "Execution failed";
  if (receipt.execution === "succeeded" && receipt.effect === "pending") {
    return "Execution finished · publication pending";
  }
  if (receipt.execution === "running") return "Running · last confirmed by runtime";
  if (receipt.execution === "blocked") return "Runtime blocked";
  if (receipt.execution === "runtime_acknowledged") return "Runtime acknowledged";
  return "Dispatch durably accepted";
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
  panelView,
  onCreateLocal,
  onSwitchAudience,
  onSendMessage,
  onDispatch,
}: {
  readonly surface: OrchestratorThreadSurface;
  readonly onCreate: () => void;
  readonly onOpen: (elementId: string) => void;
  readonly onClose: () => void;
  readonly onJump: (elementId: string) => void;
  readonly onClusterNavigate: (action: ClusterNavigation) => void;
  readonly panelView?: OrchestratorThreadPanelView | null;
  readonly onCreateLocal?: () => void;
  readonly onSwitchAudience?: (audience: "private" | "drawing") => void;
  readonly onSendMessage?: (text: string) => Promise<void> | void;
  readonly onDispatch?: (input: {
    objectiveSummary: string;
    targetContextId: string;
    connectionId: string;
    profileId: string;
  }) => Promise<void> | void;
}) => {
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dispatchSummary, setDispatchSummary] = useState("");
  const [dispatchComposerOpen, setDispatchComposerOpen] = useState(false);
  const [targetContextId, setTargetContextId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [profileId, setProfileId] = useState("");
  const byElementId = useMemo(
    () => new Map(surface.anchors.map((item) => [item.elementId, item] as const)),
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

  useEffect(() => {
    // A draft belongs to the immutable thread/audience it was composed for.
    // Carrying local text into a Multiplayer composer would turn switching
    // into an implicit publication affordance even though histories remain
    // separate on the server.
    setDraft("");
    setDispatchSummary("");
    setDispatchComposerOpen(false);
  }, [panelView?.threadId]);

  const selectedConnection = panelView?.dispatch?.connections.find(
    (connection) => connection.id === connectionId,
  );

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
            Place shared thread here
          </button>
          {onCreateLocal ? (
            <button
              type="button"
              className="orchestrator-thread-invitation__local"
              onClick={onCreateLocal}
            >
              Start a local thread
            </button>
          ) : null}
          <small>Messages and dispatch are added only through their explicit contracts.</small>
        </section>
      ) : null}

      {surface.clusters.map((cluster) => {
        if (cluster.members.length === 1) {
          const item = byElementId.get(cluster.members[0]!.elementId);
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
                onClick={() => onOpen(item.elementId)}
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
              <Layers3 size={15} /> {cluster.members.length} threads
            </button>
            {expanded ? (
              <div className="orchestrator-thread-cluster__members" role="menu">
                {cluster.members.map((member) => {
                  const item = byElementId.get(member.elementId);
                  if (!item) return null;
                  return (
                    <button
                      key={member.elementId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        // Navigation to exactly one original anchor is the
                        // cluster's entire action vocabulary. No Context,
                        // Dispatch or Lease action exists at this boundary.
                        onClusterNavigate({ kind: "navigate", ...member });
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
              {locator.members.length === 1 ? "1 thread" : `${locator.members.length} threads`}
            </button>
            {expanded ? (
              <div className="orchestrator-thread-locator__members" role="menu">
                {locator.members.map((member) => {
                  const item = byElementId.get(member.elementId);
                  if (!item) return null;
                  return (
                    <button
                      key={member.elementId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onClusterNavigate({ kind: "navigate", ...member });
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

          {panelView ? (
            <div className="orchestrator-thread-panel__audiences" aria-label="Thread audience">
              <button
                type="button"
                aria-pressed={panelView.audience === "private"}
                onClick={() => onSwitchAudience?.("private")}
              >
                <Lock size={13} /> Local
              </button>
              <button
                type="button"
                aria-pressed={panelView.audience === "drawing"}
                onClick={() => onSwitchAudience?.("drawing")}
              >
                <Users size={13} /> Multiplayer
              </button>
              <small>
                {panelView.audience === "private"
                  ? "Only you can read this server-saved history. Switching opens another thread; it never publishes this one."
                  : "Everyone with Board access can read this history. It is a separate thread, not a visibility toggle."}
              </small>
            </div>
          ) : null}

          {surface.active.placement.mode === "docked" ? (
            <button
              type="button"
              className="orchestrator-thread-panel__location"
              onClick={() => onJump(surface.active!.anchor.elementId)}
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

          {panelView ? (
            <>
              <div className="orchestrator-thread-panel__events" aria-live="polite">
                {panelView.loading ? <p>Loading history…</p> : null}
                {!panelView.loading && panelView.events.length === 0 ? (
                  <div className="orchestrator-thread-panel__empty">
                    <Layers3 size={24} />
                    <strong>No orchestrator events yet</strong>
                    <p>
                      This {panelView.audience === "private" ? "local" : "shared"} thread has its
                      own immutable audience. Visual proximity never changes it.
                    </p>
                  </div>
                ) : null}
                {panelView.events.map((event) => (
                  <article key={event.id} data-kind={event.kind}>
                    <header>
                      <strong>{event.actor.displayName}</strong>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </header>
                    <p>
                      {typeof event.payload.text === "string"
                        ? event.payload.text
                        : typeof event.payload.title === "string"
                          ? event.payload.title
                          : event.kind}
                    </p>
                  </article>
                ))}
                {panelView.error ? <p role="alert">{panelView.error}</p> : null}
              </div>
              {(panelView.receipts ?? []).length > 0 ? (
                <section
                  className="orchestrator-thread-panel__receipts"
                  aria-label="Public dispatch receipts"
                >
                  <strong>Public responsibility</strong>
                  {(panelView.receipts ?? []).map((receipt) => (
                    <article
                      key={receipt.id}
                      data-execution={receipt.execution}
                      data-effect={receipt.effect}
                    >
                      <span>{receipt.objectiveSummary}</span>
                      <strong>{receiptLabel(receipt)}</strong>
                      <small>
                        Accepted{" "}
                        {new Date(receipt.acceptedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    </article>
                  ))}
                </section>
              ) : null}
              {panelView.canWrite && panelView.dispatch && !dispatchComposerOpen ? (
                <button
                  type="button"
                  className="orchestrator-thread-panel__dispatch-toggle"
                  onClick={() => setDispatchComposerOpen(true)}
                >
                  <Bot size={14} /> Approve a public effect
                </button>
              ) : null}
              {panelView.canWrite && panelView.dispatch && dispatchComposerOpen ? (
                <form
                  className="orchestrator-thread-panel__dispatch"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      panelView.dispatch?.submitting ||
                      panelView.dispatch?.blocked ||
                      !dispatchSummary.trim() ||
                      !targetContextId ||
                      !connectionId ||
                      !profileId
                    )
                      return;
                    void Promise.resolve(
                      onDispatch?.({
                        objectiveSummary: dispatchSummary.trim(),
                        targetContextId,
                        connectionId,
                        profileId,
                      }),
                    ).then(
                      () => {
                        setDispatchSummary("");
                        setDispatchComposerOpen(false);
                      },
                      () => undefined,
                    );
                  }}
                >
                  <strong>Approve a public effect</strong>
                  <small>
                    Only this summary becomes shared responsibility. Local messages are never
                    published.
                  </small>
                  {panelView.dispatch.blocked ? (
                    <p role="status">Dispatch paused: the Board thread view is saturated.</p>
                  ) : null}
                  <textarea
                    aria-label="Approved public objective"
                    placeholder="What may the agent make public?"
                    value={dispatchSummary}
                    onChange={(event) => setDispatchSummary(event.target.value)}
                    maxLength={2_000}
                    rows={2}
                  />
                  <select
                    aria-label="Public effect Context"
                    value={targetContextId}
                    onChange={(event) => setTargetContextId(event.target.value)}
                  >
                    <option value="">Choose Context…</option>
                    {panelView.dispatch.contexts.map((context) => (
                      <option key={context.id} value={context.id}>
                        {context.frameElementId}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Agent runtime connection"
                    value={connectionId}
                    onChange={(event) => {
                      setConnectionId(event.target.value);
                      setProfileId("");
                    }}
                  >
                    <option value="">Choose runtime…</option>
                    {panelView.dispatch.connections
                      .filter((connection) => connection.health.connected)
                      .map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.label}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label="Agent runtime profile"
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value)}
                  >
                    <option value="">Choose profile…</option>
                    {selectedConnection?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={
                      panelView.dispatch.submitting ||
                      panelView.dispatch.blocked ||
                      !dispatchSummary.trim() ||
                      !targetContextId ||
                      !connectionId ||
                      !profileId
                    }
                  >
                    {panelView.dispatch.submitting ? "Dispatching…" : "Dispatch publicly"}
                  </button>
                  <button
                    type="button"
                    className="orchestrator-thread-panel__dispatch-cancel"
                    onClick={() => {
                      setDispatchComposerOpen(false);
                      setDispatchSummary("");
                    }}
                  >
                    Cancel public approval
                  </button>
                </form>
              ) : null}
              {panelView.canWrite ? (
                <form
                  className="orchestrator-thread-panel__composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = draft.trim();
                    if (!text || panelView.sending) return;
                    void Promise.resolve(onSendMessage?.(text)).then(
                      () => setDraft(""),
                      () => undefined,
                    );
                  }}
                >
                  <label htmlFor="orchestrator-thread-message">Message this audience</label>
                  <div>
                    <textarea
                      id="orchestrator-thread-message"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      maxLength={10_000}
                      rows={1}
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim() || panelView.sending}
                      aria-label="Send message"
                    >
                      <Send size={15} />
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          ) : (
            <div className="orchestrator-thread-panel__empty">
              <Layers3 size={24} />
              <strong>No orchestrator events yet</strong>
              <p>
                This shared anchor keeps the thread at the place it coordinates. Message audience,
                Dispatch and Lease effects arrive through their own contracts, never through visual
                proximity.
              </p>
            </div>
          )}
        </aside>
      ) : null}
    </div>
  );
};
