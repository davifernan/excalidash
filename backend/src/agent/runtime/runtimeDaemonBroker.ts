import { randomUUID } from "node:crypto";
import {
  RUNTIME_DAEMON_PROTOCOL_VERSION,
  runtimeDaemonCommandSchema,
  runtimeDaemonCommandResultSchema,
  type RuntimeDaemonCommand,
  type RuntimeDaemonCommandResult,
  type RuntimeDaemonStatusEvent,
} from "@excalidash/domain";
import {
  AgentRuntimeError,
  type AgentRuntimeConnection,
  type RuntimeStatusEvent,
} from "./contracts";
import type { AgentRuntimeConnectionSource } from "./registry";
import type { AuthenticatedRuntimeDaemon } from "./runtimeDaemonService";

const CONNECTION_STALE_MS = 45_000;
const COMMAND_ACCEPT_DEADLINE_MS = 15_000;
// Codex start may make three sequential 10-second app-server requests
// (initialize, thread/start, optional turn/start). Start this result deadline
// only after delivery and keep it above that valid execution budget while
// still below the 45-second session
// liveness boundary, so a healthy cold start is not reported as failed.
const COMMAND_RESULT_DEADLINE_MS = 40_000;
const LONG_POLL_MS = 25_000;

type Session = {
  daemon: AuthenticatedRuntimeDaemon;
  epoch: number;
  lastActivityAt: number;
  queue: RuntimeDaemonCommand[];
  pollWaiter: ((command: RuntimeDaemonCommand | null) => void) | null;
};

type PendingCommand = {
  daemonId: string;
  epoch: number;
  command: RuntimeDaemonCommand;
  delivered: boolean;
  resolve: (result: RuntimeDaemonCommandResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

type RuntimeBinding = {
  daemonId: string;
  epoch: number;
  internalHandle: string;
  remoteHandle: string;
  status: RuntimeStatusEvent;
};

const connectionIdOf = (daemonId: string): string => `daemon:${daemonId}`;

const configOf = (connection: AgentRuntimeConnection): { daemonId: string; epoch: number } => {
  const value = connection.adapterConfig as { daemonId?: unknown; epoch?: unknown } | null;
  if (!value || typeof value.daemonId !== "string" || !Number.isInteger(value.epoch)) {
    throw new AgentRuntimeError(
      "RUNTIME_NOT_CONFIGURED",
      "The outbound runtime connection is not configured.",
    );
  }
  return { daemonId: value.daemonId, epoch: value.epoch as number };
};

export class RuntimeDaemonBroker implements AgentRuntimeConnectionSource {
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #bindings = new Map<string, RuntimeBinding>();
  readonly #listeners = new Map<string, Set<(event: RuntimeStatusEvent) => void>>();
  readonly #revoked = new Set<string>();

  activate(daemon: AuthenticatedRuntimeDaemon): void {
    const previous = this.#sessions.get(daemon.id);
    if (this.#revoked.has(daemon.id) || (previous && previous.epoch >= daemon.sessionEpoch)) return;
    if (previous) {
      previous.pollWaiter?.(null);
      this.#rejectEpoch(previous.daemon.id, previous.epoch);
    }
    this.#sessions.set(daemon.id, {
      daemon,
      epoch: daemon.sessionEpoch,
      lastActivityAt: Date.now(),
      queue: [],
      pollWaiter: null,
    });
  }

  revoke(daemonId: string): void {
    this.#revoked.add(daemonId);
    const session = this.#sessions.get(daemonId);
    if (!session) return;
    session.pollWaiter?.(null);
    this.#rejectEpoch(daemonId, session.epoch);
    this.#sessions.delete(daemonId);
  }

  #rejectEpoch(daemonId: string, epoch: number): void {
    const session = this.#sessions.get(daemonId);
    if (session?.epoch === epoch) session.queue.length = 0;
    for (const [commandId, pending] of this.#pending) {
      if (pending.daemonId !== daemonId || pending.epoch !== epoch) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(commandId);
      pending.reject(
        new AgentRuntimeError(
          pending.delivered ? "RUNTIME_REQUEST_FAILED" : "RUNTIME_NOT_CONNECTED",
          pending.delivered
            ? "The runtime disconnected before acknowledging the request."
            : "The runtime is not connected.",
        ),
      );
    }
    for (const [handle, binding] of this.#bindings) {
      if (binding.daemonId === daemonId && binding.epoch === epoch) {
        this.#bindings.delete(handle);
        this.#listeners.get(handle)?.forEach((listener) => listener({ status: "unknown" }));
        this.#listeners.delete(handle);
      }
    }
  }

  #activeSession(daemonId: string, epoch?: number): Session | null {
    const session = this.#sessions.get(daemonId);
    if (!session || (epoch !== undefined && session.epoch !== epoch)) return null;
    if (Date.now() - session.lastActivityAt > CONNECTION_STALE_MS) return null;
    return session;
  }

  #expire(pending: PendingCommand): void {
    if (this.#pending.get(pending.command.commandId) !== pending) return;
    this.#pending.delete(pending.command.commandId);
    const session = this.#sessions.get(pending.daemonId);
    if (session?.epoch === pending.epoch) {
      const queuedIndex = session.queue.findIndex(
        (queuedCommand) => queuedCommand.commandId === pending.command.commandId,
      );
      if (queuedIndex >= 0) session.queue.splice(queuedIndex, 1);
    }
    pending.reject(
      new AgentRuntimeError(
        pending.delivered ? "RUNTIME_REQUEST_FAILED" : "RUNTIME_NOT_CONNECTED",
        pending.delivered
          ? "The runtime did not acknowledge the request before its deadline."
          : "The runtime daemon did not accept the request.",
      ),
    );
  }

  #setDeadline(pending: PendingCommand, delayMs: number): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.#expire(pending), delayMs);
    pending.timer.unref();
  }

  #markDelivered(pending: PendingCommand): void {
    if (pending.delivered) return;
    pending.delivered = true;
    this.#setDeadline(pending, COMMAND_RESULT_DEADLINE_MS);
  }

  listConnections(userId: string): AgentRuntimeConnection[] {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          session.daemon.ownerUserId === userId &&
          Date.now() - session.lastActivityAt <= CONNECTION_STALE_MS,
      )
      .map((session) => this.#connectionOf(session));
  }

  resolve(connectionId: string, userId: string): AgentRuntimeConnection | null {
    const session = [...this.#sessions.values()].find(
      (candidate) =>
        connectionIdOf(candidate.daemon.id) === connectionId &&
        candidate.daemon.ownerUserId === userId &&
        Date.now() - candidate.lastActivityAt <= CONNECTION_STALE_MS,
    );
    return session ? this.#connectionOf(session) : null;
  }

  isActiveConnection(connection: AgentRuntimeConnection): boolean {
    const config = configOf(connection);
    return this.#activeSession(config.daemonId, config.epoch) !== null;
  }

  #connectionOf(session: Session): AgentRuntimeConnection {
    return {
      id: connectionIdOf(session.daemon.id),
      label: session.daemon.label,
      adapterId: "outbound-daemon",
      audience: { kind: "user", userId: session.daemon.ownerUserId },
      profiles: session.daemon.profiles,
      policyCapabilities: session.daemon.policyCapabilities,
      costBearer: {
        ownerKind: "user",
        ownerId: session.daemon.ownerUserId,
        label: session.daemon.costBearerLabel,
      },
      adapterConfig: { daemonId: session.daemon.id, epoch: session.epoch },
    };
  }

  async poll(daemonId: string, epoch: number): Promise<RuntimeDaemonCommand | null> {
    const session = this.#activeSession(daemonId, epoch);
    if (!session) {
      throw new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "The daemon session is fenced.");
    }
    session.lastActivityAt = Date.now();
    let queued = session.queue.shift();
    // A queue entry is deliverable only while its pending record still proves
    // that the caller is waiting for this exact device epoch. This is a second
    // fence behind timeout/revocation cleanup, not a substitute for it.
    while (queued && !this.#pending.has(queued.commandId)) queued = session.queue.shift();
    if (queued) {
      const pending = this.#pending.get(queued.commandId);
      if (pending) this.#markDelivered(pending);
      return queued;
    }
    session.pollWaiter?.(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (session.pollWaiter === finish) session.pollWaiter = null;
        resolve(null);
      }, LONG_POLL_MS);
      timer.unref();
      const finish = (command: RuntimeDaemonCommand | null) => {
        clearTimeout(timer);
        if (session.pollWaiter === finish) session.pollWaiter = null;
        if (command) {
          const pending = this.#pending.get(command.commandId);
          if (pending) this.#markDelivered(pending);
        }
        resolve(command);
      };
      session.pollWaiter = finish;
    });
  }

  async dispatch(
    connection: AgentRuntimeConnection,
    kind: RuntimeDaemonCommand["kind"],
    payload: RuntimeDaemonCommand["payload"],
  ): Promise<RuntimeDaemonCommandResult> {
    const config = configOf(connection);
    const session = this.#activeSession(config.daemonId, config.epoch);
    if (!session) {
      throw new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "The runtime daemon is offline.");
    }
    const command = runtimeDaemonCommandSchema.parse({
      protocolVersion: RUNTIME_DAEMON_PROTOCOL_VERSION,
      commandId: randomUUID(),
      kind,
      payload,
    });
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        daemonId: config.daemonId,
        epoch: config.epoch,
        command,
        delivered: false,
        resolve,
        reject,
        timer: null,
      };
      this.#pending.set(command.commandId, pending);
      this.#setDeadline(pending, COMMAND_ACCEPT_DEADLINE_MS);
      if (session.pollWaiter) {
        const waiter = session.pollWaiter;
        session.pollWaiter = null;
        waiter(command);
      } else {
        session.queue.push(command);
      }
    });
  }

  complete(daemonId: string, epoch: number, commandId: string, rawResult: unknown): void {
    const session = this.#activeSession(daemonId, epoch);
    const pending = this.#pending.get(commandId);
    if (!session || !pending || pending.daemonId !== daemonId || pending.epoch !== epoch) {
      throw new AgentRuntimeError(
        "RUNTIME_REQUEST_FAILED",
        "The command does not belong to this daemon session.",
      );
    }
    const result = runtimeDaemonCommandResultSchema.parse(rawResult);
    if (pending.command.kind === "start" && result.ok && !result.runtimeHandle) {
      throw new AgentRuntimeError(
        "RUNTIME_RESPONSE_INVALID",
        "The runtime omitted the new run handle.",
      );
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(commandId);
    session.lastActivityAt = Date.now();
    if (pending.command.kind === "start" && result.ok && result.runtimeHandle) {
      const internalHandle = `daemon-run:${commandId}`;
      this.#bindings.set(internalHandle, {
        daemonId,
        epoch,
        internalHandle,
        remoteHandle: result.runtimeHandle,
        status: { status: result.status, displayName: result.displayName },
      });
      pending.resolve({ ...result, runtimeHandle: internalHandle });
      return;
    }
    pending.resolve(result);
  }

  publishStatus(daemonId: string, epoch: number, event: RuntimeDaemonStatusEvent): void {
    const session = this.#activeSession(daemonId, epoch);
    const binding = [...this.#bindings.values()].find(
      (candidate) =>
        candidate.daemonId === daemonId &&
        candidate.epoch === epoch &&
        candidate.remoteHandle === event.runtimeHandle,
    );
    if (!session || !binding) {
      throw new AgentRuntimeError(
        "RUNTIME_REQUEST_FAILED",
        "The runtime event does not belong to this daemon session.",
      );
    }
    session.lastActivityAt = Date.now();
    binding.status = { status: event.status, displayName: event.displayName };
    this.#listeners.get(binding.internalHandle)?.forEach((listener) => listener(binding.status));
  }

  binding(connection: AgentRuntimeConnection, internalHandle: string): RuntimeBinding {
    const config = configOf(connection);
    const binding = this.#bindings.get(internalHandle);
    if (
      !binding ||
      binding.daemonId !== config.daemonId ||
      binding.epoch !== config.epoch ||
      !this.#activeSession(config.daemonId, config.epoch)
    ) {
      throw new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "The runtime run is unavailable.");
    }
    return binding;
  }

  subscribe(
    connection: AgentRuntimeConnection,
    internalHandle: string,
    listener: (event: RuntimeStatusEvent) => void,
  ) {
    const binding = this.binding(connection, internalHandle);
    const listeners = this.#listeners.get(internalHandle) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(internalHandle, listeners);
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#listeners.delete(internalHandle);
        resolve();
      };
    });
    return { binding, close, closed };
  }

  runtimePayload(connection: AgentRuntimeConnection, handle: string) {
    return this.binding(connection, handle);
  }
}
