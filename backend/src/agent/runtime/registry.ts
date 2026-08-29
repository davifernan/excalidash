import {
  AgentRuntimeError,
  type AgentRuntimeAdapter,
  type AgentRuntimeConnection,
} from "./contracts";

const connectionVisibleTo = (connection: AgentRuntimeConnection, userId: string): boolean =>
  connection.audience.kind === "installation" || connection.audience.userId === userId;

export class AgentRuntimeRegistry {
  readonly #adapters: ReadonlyMap<string, AgentRuntimeAdapter>;
  readonly #connections: ReadonlyMap<string, AgentRuntimeConnection>;

  constructor(params: {
    adapters: readonly AgentRuntimeAdapter[];
    connections: readonly AgentRuntimeConnection[];
  }) {
    this.#adapters = new Map(params.adapters.map((adapter) => [adapter.id, adapter]));
    this.#connections = new Map(
      params.connections.map((connection) => [connection.id, connection]),
    );
    if (this.#adapters.size !== params.adapters.length) {
      throw new Error("Agent runtime adapter ids must be unique");
    }
    if (this.#connections.size !== params.connections.length) {
      throw new Error("Agent runtime connection ids must be unique");
    }
    for (const connection of params.connections) {
      if (!this.#adapters.has(connection.adapterId)) {
        throw new Error(`No adapter registered for runtime connection ${connection.id}`);
      }
    }
  }

  listConnections(userId: string): AgentRuntimeConnection[] {
    return [...this.#connections.values()].filter((connection) =>
      connectionVisibleTo(connection, userId),
    );
  }

  resolve(
    connectionId: string,
    userId: string,
  ): {
    connection: AgentRuntimeConnection;
    adapter: AgentRuntimeAdapter;
  } {
    const connection = this.#connections.get(connectionId);
    if (!connection || !connectionVisibleTo(connection, userId)) {
      throw new AgentRuntimeError(
        "RUNTIME_NOT_CONFIGURED",
        "The selected runtime connection is not available.",
      );
    }
    const adapter = this.#adapters.get(connection.adapterId);
    if (!adapter) {
      throw new AgentRuntimeError(
        "RUNTIME_NOT_CONFIGURED",
        "The selected runtime connection is not available.",
      );
    }
    return { connection, adapter };
  }
}
