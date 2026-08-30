# Outbound Agent Runtime Daemon

Status: NIL-706, first transport slice of NIL-683. The Agent Context contracts in
[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) and the provider-neutral seam in
[`AGENT_RUNTIME_ADAPTER.md`](AGENT_RUNTIME_ADAPTER.md) remain authoritative.

## Boundary

ExcaliDash runs on a server. The daemon runs on a person's machine and makes every connection
outward to that server over HTTPS; the server never discovers, dials, tunnels into, or opens a
shell on the person's machine. Typed `start`, `prompt`, `status` and status-event envelopes are
the whole transport surface. There is no arbitrary command, terminal or file API.

The server continues to own mounts, allowed Contexts, approvals, Context Leases, Presence,
DispatchReceipts, deadlines and cost-bearer identity. Mount secrets are handed to the daemon only
after those checks have succeeded. The daemon owns only local execution and its local provider
credentials.

## Pairing, revocation and fencing

1. An authenticated browser creates a random one-use pairing code valid for ten minutes.
2. The daemon exchanges that code once for a high-entropy device credential. Only hashes of both
   secrets are stored.
3. Each daemon start opens a new monotonic session epoch. Opening epoch N fences every pending
   command and late event from epoch N-1.
4. A command is bound to its device id and epoch. A different paired daemon cannot claim or
   acknowledge it. Revocation increments the epoch and removes the live connection immediately.

Long polling is deliberate: it is ordinary outbound HTTPS and works through the same reverse
proxy and NAT path as other client requests. A delivered start that loses its acknowledgement is
not retried. The existing DispatchReceipt deadline turns that uncertainty into `outcome_unknown`;
silence never becomes success.

Network loss stops every local executor owned by that daemon session before the daemon reconnects
with a new epoch. This keeps paid work inside the server-authoritative assignment lifecycle rather
than allowing it to continue invisibly. HTTP requests have a 40-second absolute deadline, and an
individual local app-server request has a 10-second absolute deadline; activity cannot extend
either bound.

## First executor: Codex CLI

The first local executor is Codex CLI's documented stable `app-server` JSONL API. The daemon uses
`initialize`, `thread/start` and `turn/start`; Codex method names, thread ids, the executable path
and the local working directory stop at the daemon and never cross the server-side
`AgentRuntimeAdapter` contract. This implementation was built from the public
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), not from another
project's source.

Provider authentication remains local: the person runs `codex login` on their own machine. The
daemon neither uploads those credentials nor implements the separate OAuth/PKCE work tracked by
NIL-707.

Pair and run:

```bash
excalidash-runtime-daemon pair \
  --server https://excalidash.example.com \
  --code 'exd_pair_…' \
  --cwd /absolute/path/to/workspace
excalidash-runtime-daemon run
```

The local config and dedupe journal are mode `0600`. A corrupt journal fails closed because its
absence cannot prove that paid work was never started.

## Version and cost display

There is intentionally no updater in this slice. The daemon reports its version when pairing and
opening a session. `AGENT_RUNTIME_DAEMON_MIN_VERSION` (default `0.16.0`) is the server's accepted
minimum; an older daemon is rejected with a visible upgrade-required response. Updating code on
another person's machine requires a separate product and security decision.

The Board shows the server-owned cost-bearer label before a start. A daemon may report a plan name
and textual limits for its owner's management view. ExcaliDash does not display monetary amounts
or token-cost estimates without an authoritative consumption source.
