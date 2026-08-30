import {
  runtimeDaemonCommandSchema,
  type RuntimeDaemonCommand,
  type RuntimeDaemonCommandResult,
  type RuntimeDaemonStatusEvent,
} from "@excalidash/domain";
import { CodexAppServerExecutor } from "./codexAppServer";

export type DaemonConfig = {
  serverUrl: string;
  credential: string;
  daemonId: string;
  version: string;
  profiles: Array<{
    id: string;
    label: string;
    executor: "codex";
    workingDirectory: string;
    executable?: string;
  }>;
};

const request = async (url: string, credential: string, body: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok && response.status !== 204) {
    const safe = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(typeof safe?.message === "string" ? safe.message : `HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
};

const reconnectDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });

export class RuntimeDaemon {
  #epoch = 0;
  readonly #executor: CodexAppServerExecutor;

  constructor(
    private readonly config: DaemonConfig,
    private readonly waitBeforeReconnect: typeof reconnectDelay = reconnectDelay,
  ) {
    this.#executor = new CodexAppServerExecutor(
      config.profiles.map(({ id, label, workingDirectory, executable }) => ({
        id,
        label,
        workingDirectory,
        executable,
      })),
      (event) => this.#sendStatus(event),
      config.serverUrl,
    );
  }

  async run(signal?: AbortSignal): Promise<void> {
    let retryDelayMs = 1_000;
    while (!signal?.aborted) {
      try {
        const session = (await request(
          `${this.config.serverUrl}/api/agent/runtime-daemons/session`,
          this.config.credential,
          {
            daemonVersion: this.config.version,
            profiles: this.config.profiles.map(({ id, label }) => ({ id, label })),
          },
        )) as { epoch: number };
        this.#epoch = session.epoch;
        retryDelayMs = 1_000;
        while (!signal?.aborted) {
          const response = (await request(
            `${this.config.serverUrl}/api/agent/runtime-daemons/commands/next`,
            this.config.credential,
            { epoch: this.#epoch },
          )) as { command?: unknown } | null;
          if (!response?.command) continue;
          const command = runtimeDaemonCommandSchema.parse(response.command);
          await this.#handle(command);
        }
      } catch {
        if (signal?.aborted) break;
        // The server-authoritative assignment ends when its daemon session is
        // lost. Do not let paid local work continue outside that lifecycle.
        this.#executor.stopAll();
        // Do not print the transport error: response messages can originate at
        // a remote boundary. The operator needs the state, not echoed content.
        process.stderr.write("Runtime connection lost; retrying.\n");
        await this.waitBeforeReconnect(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  }

  async #handle(command: RuntimeDaemonCommand): Promise<void> {
    let result: RuntimeDaemonCommandResult;
    if (command.kind === "start") result = await this.#executor.start(command.payload);
    else if (command.kind === "prompt") {
      result = await this.#executor.prompt(command.payload.runtimeHandle, command.payload.text);
    } else result = this.#executor.status(command.payload.runtimeHandle);
    await request(
      `${this.config.serverUrl}/api/agent/runtime-daemons/events`,
      this.config.credential,
      {
        kind: "command-result",
        epoch: this.#epoch,
        commandId: command.commandId,
        result,
      },
    );
  }

  async #sendStatus(event: RuntimeDaemonStatusEvent): Promise<void> {
    if (!this.#epoch) return;
    await request(
      `${this.config.serverUrl}/api/agent/runtime-daemons/events`,
      this.config.credential,
      { kind: "status", epoch: this.#epoch, event },
    );
  }
}
