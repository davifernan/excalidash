import type {
  AgentRuntimeAdapter,
  AgentRuntimeConnection,
  RuntimeStartInput,
  RuntimeStatusEvent,
} from "./contracts";
import { AgentRuntimeError } from "./contracts";
import { RuntimeDaemonBroker } from "./runtimeDaemonBroker";

const resultEvent = (result: {
  ok: boolean;
  status?: RuntimeStatusEvent["status"];
  displayName?: string;
}): RuntimeStatusEvent => {
  if (!result.ok || !result.status) {
    throw new AgentRuntimeError("RUNTIME_REQUEST_FAILED", "The runtime rejected the request.");
  }
  return { status: result.status, displayName: result.displayName };
};

export class OutboundRuntimeDaemonAdapter implements AgentRuntimeAdapter {
  readonly id = "outbound-daemon";

  constructor(private readonly broker: RuntimeDaemonBroker) {}

  async health(connection: AgentRuntimeConnection) {
    const connected = this.broker.isActiveConnection(connection);
    return {
      connected,
      status: connected ? ("connected" as const) : ("disconnected" as const),
    };
  }

  async start(connection: AgentRuntimeConnection, input: RuntimeStartInput) {
    const result = await this.broker.dispatch(connection, "start", {
      ...input,
      boardMount: input.boardMount
        ? {
            ...input.boardMount,
            allowedContextIds: [...input.boardMount.allowedContextIds],
          }
        : undefined,
    });
    const event = resultEvent(result);
    if (!result.ok || !result.runtimeHandle) {
      throw new AgentRuntimeError(
        "RUNTIME_RESPONSE_INVALID",
        "The runtime omitted the run handle.",
      );
    }
    return {
      handle: result.runtimeHandle,
      status: event.status,
      displayName: event.displayName ?? input.displayName,
    };
  }

  async prompt(
    connection: AgentRuntimeConnection,
    handle: string,
    text: string,
  ): Promise<RuntimeStatusEvent> {
    const binding = this.broker.runtimePayload(connection, handle);
    return resultEvent(
      await this.broker.dispatch(connection, "prompt", {
        runtimeHandle: binding.remoteHandle,
        text,
      }),
    );
  }

  async status(connection: AgentRuntimeConnection, handle: string): Promise<RuntimeStatusEvent> {
    const binding = this.broker.runtimePayload(connection, handle);
    return resultEvent(
      await this.broker.dispatch(connection, "status", {
        runtimeHandle: binding.remoteHandle,
      }),
    );
  }

  async subscribe(
    connection: AgentRuntimeConnection,
    handle: string,
    listener: (event: RuntimeStatusEvent) => void,
  ) {
    const subscription = this.broker.subscribe(connection, handle, listener);
    return { close: subscription.close, closed: subscription.closed };
  }
}
