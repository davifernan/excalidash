# ExcaliDash Runtime Daemon

This is the user-side process for an outbound ExcaliDash agent runtime. It does not listen on a
port. Every request goes from this machine to the configured ExcaliDash HTTPS origin.

Build it from the reviewed ExcaliDash checkout:

```bash
npm install
npm run build --workspace @excalidash/domain
npm run build --workspace @excalidash/runtime-daemon
```

Create a one-use code in the Board's **Agents → Pair a computer** panel, then run:

```bash
node packages/runtime-daemon/dist/cli.js pair \
  --server https://excalidash.example.com \
  --code 'exd_pair_…' \
  --cwd /absolute/path/to/workspace
codex login
node packages/runtime-daemon/dist/cli.js run
```

The daemon uses Codex CLI's documented `app-server` interface. It has no self-updater and stores
the device credential under `~/.config/excalidash-runtime-daemon/` with owner-only permissions. See
[`../../docs/architecture/RUNTIME_DAEMON.md`](../../docs/architecture/RUNTIME_DAEMON.md) for the
security and lifecycle contract.
