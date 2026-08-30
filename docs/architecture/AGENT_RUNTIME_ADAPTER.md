# Agent Runtime Adapter

Status: runtime seam and first Herdr adapter for NIL-673. The Agent Context contracts in
[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) remain authoritative.

## Boundary

ExcaliDash owns authorization, delegation, connection visibility and the board-facing API.
An `AgentRuntimeAdapter` owns only runtime lifecycle operations: health, start, prompt, status
and status subscription. Its public contract contains no Herdr method names, socket paths,
workspace IDs or pane IDs. Runtime-specific configuration and handles remain opaque behind the
adapter and the authenticated, encrypted run capability.

Connections have a server-enforced audience: either the whole installation or one user. The
registry applies that audience before a connection can be listed or resolved. This deliberately
keeps both answers to NIL-683 possible. The first concrete connection talks to a co-located
Herdr Unix socket; a future paired/outbound transport can register user-audienced connections
without changing the board routes or adapter contract.

No Herdr socket is exposed to the browser. ExcaliDash does not proxy arbitrary Herdr methods,
terminal input or filesystem access.

## Board API and authentication

The UI uses five narrowly scoped drawing routes:

- `GET /drawings/:id/agent/runtime` lists visible connections and health.
- `POST /drawings/:id/agent/run` starts one approved profile.
- `GET /drawings/:id/agent/run` reads one run's status.
- `POST /drawings/:id/agent/prompt` sends one prompt.
- `POST /drawings/:id/agent/events` opens an authenticated status stream.

All routes run through the existing drawing authorization boundary. Cookie sessions and the
existing board-scoped API keys are the only credentials; there is no second token system for
agents. API-key route access requires the exact `agent:read`, `agent:run` or `agent:prompt`
scope. The event stream is a POST so its short-lived run capability never appears in a URL,
browser history or proxy access log.

The runtime panel keeps that run capability in memory only. Closing or reloading the editor
drops it. The encrypted capability is bound to the run, drawing, connection, opaque runtime
handle, caller identity, effective capabilities and expiry. Every later action also intersects
the approved dispatch with the current Context Policy, the connection's current Runtime Policy
and the caller's current board access. Revoking edit access or narrowing the Runtime Policy
therefore revokes prompt authority even while the capability has time left.

## Delegated capabilities

The canonical vocabulary is:

`board:read`, `agent:read`, `agent:run`, `agent:prompt`, `artifact:publish`, `board:write`,
`terminal:read`, `terminal:input`.

The effective set is always:

`current human rights ∩ approved dispatch ∩ context policy ∩ runtime policy`.

Unknown strings are discarded. `agent:run` never implies `board:write`. The Herdr connection
in this slice permits only `agent:read`, `agent:run` and `agent:prompt`; terminal capabilities
are defined for a stable future contract but are not exposed by any route or UI.

## Herdr lifecycle

The Herdr adapter connects to its owner-only newline-delimited JSON Unix socket. Starting a run
creates an unfocused workspace, starts one configured agent profile in that workspace and sends
the optional first prompt. Status is normalized to `working`, `idle`, `blocked`, `done` or
`unknown`; subscriptions listen only for the started pane. A failed partial start closes the
new workspace best-effort.

Transport responses are bounded to 1 MiB. Requests and the acknowledgement phase of a
subscription have an absolute ten-second deadline that incoming bytes cannot extend. After a
valid subscription acknowledgement, no inactivity or total-duration deadline applies: this is
the deliberately long-lived status channel, and a quiet run is valid. It closes with its owning
SSE response, on failed periodic authorization, on runtime disconnect, or when the caller closes
it. Socket paths, workspace IDs, pane IDs and raw runtime errors are never returned to clients. A
disconnected or unconfigured runtime disables only agent start/status; the board and canvas remain
available.

## Configuration and runtime topology

The direct Herdr connection is enabled only when all three variables are present:

```dotenv
AGENT_RUNTIME_HERDR_SOCKET_PATH=/run/user/1000/herdr.sock
AGENT_RUNTIME_HERDR_WORKING_DIRECTORY=/srv/excalidash-agent-workspace
AGENT_RUNTIME_HERDR_PROFILES='[{"id":"codex","label":"Codex","agentKind":"codex","args":[]}]'
AGENT_RUNTIME_OPERATOR_ID=installation
AGENT_RUNTIME_OPERATOR_LABEL='Instance operator'
```

Profiles are an administrator allowlist; callers choose an ID, not an executable or arbitrary
arguments. Between one and twenty profiles are accepted.

`AGENT_RUNTIME_OPERATOR_ID` is a server-only stable audit mapping. It is never emitted in a
route, socket payload, log, or mount handoff. `AGENT_RUNTIME_OPERATOR_LABEL` is a trusted,
human-readable cost-bearer snapshot: the Board shows it before dispatch, while work is active,
and in the durable receipt history. It is not a provider token or a money/token estimate.

NIL-683 is decided: ExcaliDash is self-hosted on a server, while a person's runtime may be on a
different machine behind NAT. The server never dials that machine. A user-paired daemon polls the
server outward over HTTPS and registers a user-audienced connection behind the same
`AgentRuntimeAdapter` seam. Pairing, epochs, fencing and the first Codex CLI executor are specified
in [`RUNTIME_DAEMON.md`](RUNTIME_DAEMON.md). Herdr remains an optional installation-local adapter;
it is not treated as a transport to a user's laptop.
