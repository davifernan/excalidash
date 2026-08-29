import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Loader2, Send, X } from "lucide-react";
import {
  getAgentRuntimeConnections,
  promptAgentRuntimeRun,
  startAgentRuntimeRun,
  subscribeAgentRuntimeRun,
  type AgentRuntimeConnection,
  type AgentRuntimeRun,
} from "../../api/agentRuntime";
import { notify } from "../../notifications";
import "./AgentRuntimePanel.css";

type ActiveRun = AgentRuntimeRun & { capability: string };

export const AgentRuntimePanel = ({
  container,
  drawingId,
  open,
  onClose,
}: {
  container: HTMLElement | null;
  drawingId?: string;
  open: boolean;
  onClose: () => void;
}) => {
  const [connections, setConnections] = useState<AgentRuntimeConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [displayName, setDisplayName] = useState("Board agent");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);

  useEffect(() => {
    if (!open || !drawingId) return;
    let cancelled = false;
    setLoading(true);
    void getAgentRuntimeConnections(drawingId)
      .then((next) => {
        if (cancelled) return;
        setConnections(next);
        const first = next[0];
        setConnectionId((current) => current || first?.id || "");
        setProfileId((current) => current || first?.profiles[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drawingId, open]);

  const connection = useMemo(
    () => connections.find((candidate) => candidate.id === connectionId) ?? null,
    [connectionId, connections],
  );

  useEffect(() => {
    if (!connection || connection.profiles.some((profile) => profile.id === profileId)) return;
    setProfileId(connection.profiles[0]?.id ?? "");
  }, [connection, profileId]);

  useEffect(() => {
    if (!drawingId || !activeRun) return;
    setStreamConnected(true);
    return subscribeAgentRuntimeRun(
      drawingId,
      activeRun.capability,
      (event) => {
        setStreamConnected(true);
        setActiveRun((current) =>
          current && current.id === event.id
            ? {
                ...current,
                status: event.status,
                displayName: event.displayName || current.displayName,
              }
            : current,
        );
      },
      () => setStreamConnected(false),
    );
  }, [activeRun?.capability, activeRun?.id, drawingId]);

  if (!container || !open) return null;

  const start = async () => {
    if (!drawingId || !connectionId || !profileId) return;
    setLoading(true);
    try {
      const result = await startAgentRuntimeRun(drawingId, {
        connectionId,
        profileId,
        displayName,
        initialPrompt: initialPrompt.trim() || undefined,
      });
      setActiveRun({ ...result.run, capability: result.runCapability });
      setInitialPrompt("");
    } catch {
      notify("error", "The agent runtime could not start this run.");
    } finally {
      setLoading(false);
    }
  };

  const sendPrompt = async () => {
    if (!drawingId || !activeRun || !prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    try {
      const result = await promptAgentRuntimeRun(drawingId, activeRun.capability, text);
      setActiveRun((current) => (current ? { ...current, status: result.status } : current));
    } catch {
      notify("error", "The agent runtime could not accept the prompt.");
    }
  };

  return createPortal(
    <aside
      className="agent-runtime-panel"
      aria-label="Agent runtime"
      data-testid="agent-runtime-panel"
    >
      <header>
        <span className="agent-runtime-panel__title">
          <Bot size={17} /> Agents
        </span>
        <button type="button" onClick={onClose} aria-label="Close agent runtime">
          <X size={17} />
        </button>
      </header>
      {loading && connections.length === 0 ? (
        <div className="agent-runtime-panel__empty">
          <Loader2 className="animate-spin" size={18} /> Connecting…
        </div>
      ) : connections.length === 0 ? (
        <div className="agent-runtime-panel__empty">
          <strong>Runtime not connected</strong>
          <span>The board remains available. Connect a runtime to start an agent.</span>
        </div>
      ) : activeRun ? (
        <div className="agent-runtime-panel__body">
          <div className="agent-runtime-panel__run">
            <span
              className={`agent-runtime-panel__status agent-runtime-panel__status--${activeRun.status}`}
            />
            <div>
              <strong>{activeRun.displayName}</strong>
              <small>
                {activeRun.status}
                {streamConnected ? " · live" : " · disconnected"}
              </small>
            </div>
          </div>
          <label>
            Prompt
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={20_000}
              rows={4}
            />
          </label>
          <button
            className="agent-runtime-panel__primary"
            type="button"
            onClick={() => void sendPrompt()}
            disabled={!prompt.trim()}
          >
            <Send size={15} /> Send prompt
          </button>
        </div>
      ) : (
        <div className="agent-runtime-panel__body">
          <label>
            Runtime
            <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {item.health.connected ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Profile
            <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {connection?.profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            First prompt
            <textarea
              value={initialPrompt}
              onChange={(event) => setInitialPrompt(event.target.value)}
              maxLength={20_000}
              rows={5}
            />
          </label>
          <button
            className="agent-runtime-panel__primary"
            type="button"
            onClick={() => void start()}
            disabled={loading || !connection?.health.connected || !displayName.trim() || !profileId}
          >
            {loading ? <Loader2 className="animate-spin" size={15} /> : <Bot size={15} />} Start
            agent
          </button>
          {!connection?.health.connected ? (
            <small className="agent-runtime-panel__hint">
              Runtime offline. The canvas is unaffected.
            </small>
          ) : null}
        </div>
      )}
    </aside>,
    container,
  );
};
