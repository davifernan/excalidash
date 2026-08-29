import net from "net";
import crypto from "crypto";
import { AgentRuntimeError, type RuntimeSubscription } from "./contracts";

const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

type HerdrResult = Record<string, unknown> & { type?: string };

const requestLine = (
  method: string,
  params: Record<string, unknown>,
): { id: string; line: string } => {
  const id = crypto.randomUUID();
  return { id, line: `${JSON.stringify({ id, method, params })}\n` };
};

const parseResult = (line: string, expectedId: string): HerdrResult => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AgentRuntimeError("RUNTIME_RESPONSE_INVALID", "Runtime returned invalid JSON.");
  }
  if (!value || typeof value !== "object") {
    throw new AgentRuntimeError(
      "RUNTIME_RESPONSE_INVALID",
      "Runtime returned an invalid response.",
    );
  }
  const response = value as Record<string, unknown>;
  if (
    response.id !== expectedId ||
    response.ok !== true ||
    !response.result ||
    typeof response.result !== "object"
  ) {
    throw new AgentRuntimeError("RUNTIME_REQUEST_FAILED", "Runtime rejected the request.");
  }
  return response.result as HerdrResult;
};

const connect = (socketPath: string): net.Socket => net.createConnection({ path: socketPath });

export interface HerdrTransport {
  request(
    socketPath: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<HerdrResult>;
  subscribe(
    socketPath: string,
    subscriptions: readonly Record<string, unknown>[],
    listener: (event: Record<string, unknown>) => void,
  ): Promise<RuntimeSubscription>;
}

/** Newline-delimited JSON over Herdr's owner-only Unix socket. */
export class UnixHerdrTransport implements HerdrTransport {
  constructor(private readonly requestDeadlineMs = DEFAULT_TIMEOUT_MS) {}

  async request(
    socketPath: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<HerdrResult> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const request = requestLine(method, params);
      let settled = false;
      let buffered = "";
      let deadline: NodeJS.Timeout;
      const finish = (error?: unknown, result?: HerdrResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      deadline = setTimeout(
        () => finish(new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "Runtime request timed out.")),
        this.requestDeadlineMs,
      );
      socket.once("error", () =>
        finish(new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "Runtime is not connected.")),
      );
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
          finish(
            new AgentRuntimeError("RUNTIME_RESPONSE_INVALID", "Runtime response is too large."),
          );
          return;
        }
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(undefined, parseResult(buffered.slice(0, newline), request.id));
        } catch (error) {
          finish(error);
        }
      });
      socket.once("connect", () => socket.write(request.line));
    });
  }

  async subscribe(
    socketPath: string,
    subscriptions: readonly Record<string, unknown>[],
    listener: (event: Record<string, unknown>) => void,
  ): Promise<RuntimeSubscription> {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const request = requestLine("events.subscribe", { subscriptions });
      let acknowledged = false;
      let buffered = "";
      let acknowledgementDeadline: NodeJS.Timeout;
      const failBeforeAck = (error?: unknown) => {
        if (!acknowledged) {
          clearTimeout(acknowledgementDeadline);
          reject(
            error ?? new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "Runtime is not connected."),
          );
        }
        socket.destroy();
      };
      acknowledgementDeadline = setTimeout(() => {
        failBeforeAck(
          new AgentRuntimeError("RUNTIME_NOT_CONNECTED", "Runtime subscription timed out."),
        );
      }, this.requestDeadlineMs);
      socket.once("error", failBeforeAck);
      socket.once("close", resolveClosed);
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
          failBeforeAck();
          return;
        }
        while (buffered.includes("\n")) {
          const newline = buffered.indexOf("\n");
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line.trim()) continue;
          if (!acknowledged) {
            try {
              const result = parseResult(line, request.id);
              if (result.type !== "subscription_started") {
                throw new AgentRuntimeError(
                  "RUNTIME_RESPONSE_INVALID",
                  "Runtime did not acknowledge the subscription.",
                );
              }
              acknowledged = true;
              clearTimeout(acknowledgementDeadline);
              resolve({ close: () => socket.destroy(), closed });
            } catch (error) {
              failBeforeAck(error);
            }
            continue;
          }
          try {
            const event = JSON.parse(line);
            if (event && typeof event === "object") listener(event as Record<string, unknown>);
          } catch {
            // One malformed pushed event is ignored; the authenticated stream
            // stays alive and may still deliver later valid state changes.
          }
        }
      });
      socket.once("connect", () => socket.write(request.line));
    });
  }
}
