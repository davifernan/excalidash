import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { RuntimeDaemonCommandResult, RuntimeDaemonStatusEvent } from "@excalidash/domain";

type Profile = {
  id: string;
  label: string;
  workingDirectory: string;
  executable?: string;
};

type StartInput = {
  profileId: string;
  displayName: string;
  initialPrompt?: string;
  runId: string;
  drawingId: string;
  dispatchId?: string;
  boardMount?: {
    revisionId: string;
    capabilityToken: string;
    allowedContextIds: readonly string[];
  };
};

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type SpawnAppServer = (
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;
type Run = {
  process: ChildProcessWithoutNullStreams;
  threadId: string;
  status: RuntimeDaemonStatusEvent["status"];
  displayName: string;
  pending: Map<number, Pending>;
  nextId: number;
};

const safeError = (
  code: "PROFILE_NOT_FOUND" | "EXECUTOR_UNAVAILABLE" | "EXECUTOR_REJECTED" | "REQUEST_FAILED",
) => ({
  ok: false as const,
  code,
});

/**
 * Codex-specific protocol code stops here. The server sees only the stable
 * runtime-daemon command vocabulary; app-server method names, thread IDs and
 * local working directories never cross the AgentRuntimeAdapter boundary.
 *
 * This uses only the documented stable app-server JSONL API: initialize,
 * thread/start and turn/start. Authentication remains the local Codex CLI's
 * responsibility (`codex login`); no provider credential reaches ExcaliDash.
 */
export class CodexAppServerExecutor {
  readonly #runs = new Map<string, Run>();

  constructor(
    private readonly profiles: readonly Profile[],
    private readonly onStatus: (event: RuntimeDaemonStatusEvent) => Promise<void>,
    private readonly serverUrl: string,
    private readonly spawnAppServer: SpawnAppServer = (executable, args, options) =>
      spawn(executable, args, options) as ChildProcessWithoutNullStreams,
    private readonly requestDeadlineMs = 10_000,
  ) {}

  async start(input: StartInput): Promise<RuntimeDaemonCommandResult> {
    const profile = this.profiles.find((candidate) => candidate.id === input.profileId);
    if (!profile) return safeError("PROFILE_NOT_FOUND");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnAppServer(profile.executable ?? "codex", ["app-server"], {
        cwd: profile.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          EXCALIDASH_RUN_ID: input.runId,
          EXCALIDASH_DRAWING_ID: input.drawingId,
          EXCALIDASH_API_URL: `${this.serverUrl.replace(/\/$/, "")}/api`,
          ...(input.dispatchId ? { EXCALIDASH_DISPATCH_ID: input.dispatchId } : {}),
          ...(input.boardMount
            ? {
                EXCALIDASH_REVISION_ID: input.boardMount.revisionId,
                EXCALIDASH_MOUNT_TOKEN: input.boardMount.capabilityToken,
                EXCALIDASH_ALLOWED_CONTEXT_IDS: JSON.stringify(input.boardMount.allowedContextIds),
              }
            : {}),
        },
      });
    } catch {
      return safeError("EXECUTOR_UNAVAILABLE");
    }
    const run: Run = {
      process: child,
      threadId: "",
      status: "unknown",
      displayName: input.displayName,
      pending: new Map(),
      nextId: 1,
    };
    this.#wire(run);
    try {
      await this.#request(run, "initialize", {
        clientInfo: { name: "excalidash-runtime-daemon", version: "0.16.0" },
      });
      this.#notify(run, "initialized", {});
      const thread = await this.#request(run, "thread/start", {
        cwd: profile.workingDirectory,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const threadId = thread?.thread?.id;
      if (typeof threadId !== "string" || threadId.length === 0) {
        child.kill();
        return safeError("EXECUTOR_REJECTED");
      }
      run.threadId = threadId;
      this.#runs.set(threadId, run);
      if (input.initialPrompt) await this.#startTurn(run, input.initialPrompt);
      run.status = input.initialPrompt ? "working" : "idle";
      return {
        ok: true,
        runtimeHandle: threadId,
        status: run.status,
        displayName: run.displayName,
      };
    } catch {
      child.kill();
      return safeError("EXECUTOR_REJECTED");
    }
  }

  async prompt(runtimeHandle: string, text: string): Promise<RuntimeDaemonCommandResult> {
    const run = this.#runs.get(runtimeHandle);
    if (!run) return safeError("REQUEST_FAILED");
    try {
      await this.#startTurn(run, text);
      run.status = "working";
      return { ok: true, status: run.status, displayName: run.displayName };
    } catch {
      return safeError("EXECUTOR_REJECTED");
    }
  }

  status(runtimeHandle: string): RuntimeDaemonCommandResult {
    const run = this.#runs.get(runtimeHandle);
    return run
      ? { ok: true, status: run.status, displayName: run.displayName }
      : safeError("REQUEST_FAILED");
  }

  stopAll(): void {
    for (const run of this.#runs.values()) run.process.kill();
    this.#runs.clear();
  }

  async #startTurn(run: Run, text: string): Promise<void> {
    await this.#request(run, "turn/start", {
      threadId: run.threadId,
      input: [{ type: "text", text }],
    });
  }

  #wire(run: Run): void {
    readline.createInterface({ input: run.process.stdout }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const pending = run.pending.get(message.id);
        if (!pending) return;
        run.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error("Codex app-server rejected the request"));
        else pending.resolve(message.result);
        return;
      }
      // approvalPolicy=never should make approval requests unreachable. If a
      // future app-server sends one anyway, fail closed instead of hanging.
      if (typeof message.id === "number" && typeof message.method === "string") {
        this.#write(run, { id: message.id, result: { decision: "decline" } });
        return;
      }
      if (message.method === "turn/started") run.status = "working";
      if (message.method === "turn/completed") {
        const finalStatus = message.params?.turn?.status;
        run.status = finalStatus === "completed" ? "done" : "blocked";
      }
      if (message.method === "turn/failed") run.status = "blocked";
      if (
        run.threadId &&
        ["turn/started", "turn/completed", "turn/failed"].includes(message.method)
      ) {
        this.#reportStatus({
          runtimeHandle: run.threadId,
          status: run.status,
          displayName: run.displayName,
        });
      }
    });
    run.process.once("exit", () => {
      if (run.threadId) {
        run.status = "unknown";
        this.#runs.delete(run.threadId);
        this.#reportStatus({
          runtimeHandle: run.threadId,
          status: "unknown",
          displayName: run.displayName,
        });
      }
      for (const pending of run.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex app-server exited"));
      }
      run.pending.clear();
    });
    run.process.once("error", () => {
      for (const pending of run.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex app-server could not start"));
      }
      run.pending.clear();
    });
  }

  #reportStatus(event: RuntimeDaemonStatusEvent): void {
    void this.onStatus(event).catch(() => {
      // Never echo a provider or transport error: it may contain remote or
      // document-derived data. A later status query can reconcile state.
      process.stderr.write("Runtime status delivery failed.\n");
    });
  }

  #request(run: Run, method: string, params: unknown): Promise<any> {
    const id = run.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(id);
        reject(new Error("Codex app-server request deadline exceeded"));
      }, this.requestDeadlineMs);
      timer.unref();
      run.pending.set(id, { resolve, reject, timer });
      this.#write(run, { id, method, params });
    });
  }

  #notify(run: Run, method: string, params: unknown): void {
    this.#write(run, { method, params });
  }

  #write(run: Run, message: unknown): void {
    run.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
