# Agent Board Mount

NIL-671 implements the read-only foundation specified by
[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md). This document is the executable API handoff for runtime,
Presence, Context UI, closure-hash, and guest-authorization packages. It does not grant an agent
write access.

## Persisted identity and revision

`AgentContext` is the only server-side identity mapping:

```text
contextId -> { drawingId, frameElementId, pinned }
```

`registerAgentContext()` validates the named element against the current scene and rejects
missing, deleted, non-frame, unbounded, duplicate, or overlapping Context frames. Touching edges
are allowed; an overlap with positive area is not. A live element belongs to a Context only when
its explicit `frameId` ancestry reaches that Context frame. Geometry does not create membership,
so an element without that ancestry belongs to no Context and is not an error.

An `AgentBoardRevision` stores the canonical scene, app state, file map, Context map, and immutable
asset bindings independently of ordinary `DrawingSnapshot` retention. `Drawing.version` is only
recorded as `sourceDrawingVersion`. The revision's content hash covers the actual mounted state;
therefore a Context-only change also creates a different revision even if `Drawing.version` did
not move.

An `AgentRunMount` binds exactly:

```text
{ runId, drawingId, revisionId, allowedContextIds, capabilities }
```

Its opaque capability secret is returned once; only a SHA-256 hash is stored. Normal board authz
is checked again on every request, so revoking the board grant still closes an existing mount.
The mount secret never replaces the board-scoped API key.

## Public read API

Create a mount:

```http
POST /drawings/:drawingId/agent/mounts
Authorization: Bearer <human/runtime-controller credential>
Content-Type: application/json

{
  "runId": "optional-runtime-run-id",
  "allowedContextIds": ["context-id"],
  "capabilities": ["board:explore", "board:render", "asset:read"]
}
```

Omitting `allowedContextIds` selects every Context present in that revision. An explicit empty
array selects none. There is no implicit access to elements outside Context frames.
Board-scoped agent API keys cannot call this issuer endpoint: an agent must not widen its own
scope. The controller passes the returned mount capability to the agent.

Call a tool:

```http
POST /drawings/:drawingId/agent/mounts/:runId/tools/:tool
Authorization: Bearer <board-scoped agent token>
x-agent-mount-token: <secret returned by mount creation>
Content-Type: application/json

{ ...tool arguments... }
```

Every successful response has the same envelope:

```json
{
  "runId": "runtime-run-id",
  "revisionId": "immutable-revision-id",
  "tool": "search",
  "resultHash": "sha256-of-canonical-result",
  "result": {}
}
```

`AgentToolAudit` records the run, revision, tool, canonical argument hash, and result hash. It does
not persist a second response copy or a scene dump.

| Tool | Capability | Bounded result |
| --- | --- | --- |
| `overview` | `board:explore` | Counts for readable Contexts/elements only |
| `listContexts` | `board:explore` | Allowed Context identity, frame, pin, name, and bounds |
| `listFrames` | `board:explore` | Projected readable frames |
| `readFrame` | `board:explore` | One readable frame and at most `limit` projected elements |
| `readElements` | `board:explore` | One to 100 explicitly named readable elements |
| `search` | `board:explore` | At most 100 readable text/name matches |
| `neighbors` | `board:explore` | Explicit bindings/container/frame relations, never proximity |
| `followEdge` | `board:explore` | Readable endpoints; foreign endpoints are `null` |
| `render` | `board:render` | Scoped SVG, renderer version, and referenced asset hashes |
| `readAsset` | `asset:read` | Metadata or at most 1 MiB from an asset referenced by a readable element |
| `revisionStatus` | `board:explore` | Change flag, latest revision id, and coarse scoped counts |

The element projection names geometry and explicit native relations but never forwards arbitrary
`customData`. Arrow/line results always carry `semantics.kind = "unspecified"`; native bindings
are navigation, not an inferred workflow dependency.

`resolveReference` from the planning sketch is intentionally absent. The repository has no
authoritative server-side reference encoding yet, and inventing one here would pre-empt NIL-676's
still-open semantic canonicalization. Native edge bindings remain explorable through
`neighbors`/`followEdge`; a future explicit reference contract can add a resolver through the
same per-element scope check.

## Change signal and non-drift

`revisionStatus` is the polling form of `board.changed` for this foundation. It may materialize
and name a newer revision, but its response envelope still carries the run's original
`revisionId`; it returns no new scene content. The running mount has no adopt operation. Runtime
work stops that run and creates a new one when adoption is wanted.

The Gate 1 integration fixture fixes a question ("What is the launch answer?") and answer
(`ORANGE`) inside Context A, with a cross-Context edge and secret/asset in forbidden Context B.
The tests mutate the current board to `BLUE` between two identical `readFrame` calls and require
byte-equivalent results and hashes from the original revision. They also attack Context B through
element id, edge traversal, search, render, and asset id. None may disclose its content or
metadata.
