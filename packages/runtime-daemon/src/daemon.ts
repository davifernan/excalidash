import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
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

type RuntimeExecutor = Pick<CodexAppServerExecutor, "start" | "prompt" | "status" | "stopAll">;
const parseJournalEntry = (value: unknown): true => {
  if (!value || typeof value !== "object") throw new Error("invalid journal entry");
  if ((value as { state?: unknown }).state === "claimed") return true;
  throw new Error("invalid journal entry");
};

export class RuntimeDaemon {
  readonly #journalPath: string;
  readonly #journal = new Set<string>();
  #epoch = 0;
  readonly #executor: RuntimeExecutor;

  constructor(
    private readonly config: DaemonConfig,
    stateDirectory: string,
    private readonly waitBeforeReconnect: typeof reconnectDelay = reconnectDelay,
    executor?: RuntimeExecutor,
  ) {
    this.#journalPath = path.join(stateDirectory, "assignment-journal.json");
    this.#executor =
      executor ??
      new CodexAppServerExecutor(
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
    await this.#loadJournal();
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
    if (command.kind === "start") {
      if (this.#journal.has(command.payload.assignmentId)) {
        // The durable claim proves that this assignment may already have
        // crossed the foreign execution boundary. Never turn missing outcome
        // evidence into permission to start it again.
        result = { ok: false, code: "REQUEST_FAILED" };
      } else {
        this.#journal.add(command.payload.assignmentId);
        await this.#saveJournal();
        result = await this.#executor.start(command.payload);
      }
    } else if (command.kind === "prompt") {
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

  async #loadJournal(): Promise<void> {
    this.#journal.clear();
    try {
      const parsed = JSON.parse(await readFile(this.#journalPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid journal root");
      }
      for (const [assignmentId, rawEntry] of Object.entries(parsed)) {
        parseJournalEntry(rawEntry);
        this.#journal.add(assignmentId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A corrupt journal removes the proof that an assignment was not
      // already started. Fail closed without echoing stored content.
      throw new Error("Runtime daemon assignment journal is unreadable");
    }
  }

  async #saveJournal(): Promise<void> {
    const directoryPath = path.dirname(this.#journalPath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    await chmod(directoryPath, 0o700);
    const temporary = `${this.#journalPath}.tmp`;
    const entries = [...this.#journal].map((assignmentId) => [assignmentId, { state: "claimed" }]);
    const file = await open(temporary, "w", 0o600);
    try {
      // `mode` only applies when a file is first created. chmod before writing
      // also protects against a stale temporary file left by a prior crash.
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(Object.fromEntries(entries)));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.#journalPath);
  }
}
