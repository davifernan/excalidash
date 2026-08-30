#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeDaemon, type DaemonConfig } from "./daemon";

const VERSION = "0.16.0";
const stateDirectory = path.join(os.homedir(), ".config", "excalidash-runtime-daemon");
const configPath = path.join(stateDirectory, "config.json");

const normalizeServerUrl = (raw: string): string => {
  const parsed = new URL(raw);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("The runtime daemon requires HTTPS (HTTP is allowed only for localhost)");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
};

const valueOf = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const pair = async () => {
  const serverUrl = valueOf("--server");
  const pairingCode = valueOf("--code");
  const workingDirectory = valueOf("--cwd");
  if (!serverUrl || !pairingCode || !workingDirectory) {
    throw new Error("pair requires --server, --code and --cwd");
  }
  const normalizedServer = normalizeServerUrl(serverUrl);
  const response = await fetch(`${normalizedServer}/api/agent/runtime-daemons/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode,
      daemonVersion: VERSION,
      profiles: [{ id: "codex", label: "Codex CLI" }],
    }),
  });
  const body = (await response.json().catch(() => null)) as any;
  if (!response.ok) throw new Error(body?.message ?? `Pairing failed (HTTP ${response.status})`);
  const config: DaemonConfig = {
    serverUrl: normalizedServer,
    credential: body.credential,
    daemonId: body.daemonId,
    version: VERSION,
    profiles: [{ id: "codex", label: "Codex CLI", executor: "codex", workingDirectory }],
  };
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(configPath, 0o600);
  process.stdout.write(`Paired runtime daemon ${body.daemonId}.\n`);
};

const run = async () => {
  const config = JSON.parse(await readFile(configPath, "utf8")) as DaemonConfig;
  const daemon = new RuntimeDaemon(config, stateDirectory);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await daemon.run(controller.signal);
};

const main = async () => {
  const command = process.argv[2];
  if (command === "pair") return pair();
  if (command === "run") return run();
  process.stdout.write(
    "Usage:\n  excalidash-runtime-daemon pair --server URL --code CODE --cwd DIRECTORY\n  excalidash-runtime-daemon run\n",
  );
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime daemon failed"}\n`);
  process.exitCode = 1;
});
