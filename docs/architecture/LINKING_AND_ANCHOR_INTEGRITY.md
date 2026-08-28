# Linking, live references, and local agent guidance

**Status:** measured architecture decision and migration plan for NIL-659 through NIL-663
**Measured against:** `bf03f09` (`v0.13.0`), 2026-08-28
**Decision owner:** ExcaliDash Fork
**Scope:** frame/element links, pointer integrity, optional GitHub and code references, and
path-local `AGENTS.md` guidance. This document does not implement any of them.

## Decision summary

ExcaliDash should build a small, typed anchor system, not a universal live-object graph.

1. A target receives an opaque, board-scoped `anchorId` in
   `customData.excalidash.anchor`. The source keeps the reference in Excalidraw's native
   `element.link`. Excalidraw element IDs, frame names, and `versionNonce` are explicitly not
   stable identities.
2. Same-board links are the first delivery boundary. Cross-board links follow only with an
   authorization-aware server resolver and backup remapping. Copying or importing must never
   guess a target from its name or geometry.
3. Integrity is derived by typed resolvers. Red means a deterministic missing target. A
   timeout, inaccessible private object, or ambiguous upstream `404` is not red.
4. The common watcher is extracted only after two real resolver types prove the shared state
   machine. It runs locally for same-board anchors, through an authenticated server batch for
   cross-board/external anchors, and optionally from provider webhooks later. CI is not the
   runtime for private user-board integrity.
5. GitHub cards remain a gated follow-up. If shipped, they use a read-only GitHub App and
   server-held user tokens, not anonymous polling or browser tokens.
6. Normative code and architecture diagrams remain Mermaid-in-repository. ExcaliDash drawings
   may be exploratory material, but NIL-662 should not create a second source of truth.
7. Four narrow nested guidance files are worth a measured trial:
   `frontend/src/AGENTS.md`, `frontend/src/pages/editor/AGENTS.md`, `backend/AGENTS.md`, and
   `e2e/AGENTS.md`. Vector search and an instruction router are not justified.

The core limit is intentional:

> **The watcher can detect a missing known target and a changed known fingerprint. It cannot
> prove that a diagram is topologically, semantically, or architecturally true. Green means
> “the encoded reference still resolves”, never “the drawing is correct”.**

## What exists today

### Verified seams

| Claim                                         | Measurement                                                                                                                                                                                                         | Consequence                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `element.link` crosses the adapter projection | [`adapter.ts`](../../frontend/src/integrations/excalidraw/adapter.ts) and [`capabilities.ts`](../../frontend/src/integrations/excalidraw/capabilities.ts) include links in the supported element contract           | Native links are the right source-side field; no parallel edge store is needed.                                                        |
| `customData` is part of the adapter contract  | The frontend has one parser/writer in [`customData.ts`](../../frontend/src/integrations/excalidraw/customData.ts)                                                                                                   | Add `anchor` to that canonical writer; an ad-hoc writer would be erased by the next sticky/widget update.                              |
| The server also reads the namespace           | [`backend/src/assets/customDataSchema.ts`](../../backend/src/assets/customDataSchema.ts) says it is a frontend/server contract                                                                                      | Any anchor shape read by the server must change both runtimes atomically and receive cross-runtime fixtures.                           |
| Existing private links are narrow plumbing    | [`security.ts`](../../backend/src/security.ts) accepts exactly `excalidash://pdf-widget` and `excalidash://asset-widget`; [`PdfWidget.css`](../../frontend/src/pages/editor/PdfWidget.css) hides their hyperlink UI | A new anchor URI needs an exact parser and sanitizer allow-list. Broadly accepting `excalidash://*` would weaken an existing boundary. |
| Viewport navigation exists                    | `viewport.scrollToElement` is used by comments and tested in [`viewport.test.ts`](../../frontend/src/integrations/excalidraw/viewport.test.ts)                                                                      | The final hop can reuse the adapter instead of manipulating Excalidraw DOM or app state.                                               |
| Overlay placement exists                      | `ui.overlayRoot()` is the established portal used by comments and off-screen presence                                                                                                                               | Integrity badges and a details panel have a supported UI seam.                                                                         |
| V3 backup imports re-key every board          | [`excalidashImportRoutes.ts`](../../backend/src/routes/importExport/excalidashImportRoutes.ts) builds `finalDrawingIdMap` with a fresh UUID for every V3 board                                                      | Cross-board references must be rewritten in current scenes and snapshots during a full backup restore.                                 |
| Authorization is centralized                  | [`backend/src/authz`](../../backend/src/authz) owns board access decisions                                                                                                                                          | A resolver must call this boundary; it must not re-read grants, ownership, or share tokens itself.                                     |

### One kickoff premise is false

`domBridge.ts:67` does **not** intercept link clicks. It only defines the CSS selector
`.excalidraw-hyperlinkContainer:has(a[href^="excalidash://"])`; the current widget CSS hides
that container because those links are non-navigable widget markers. The host does not provide
Excalidraw's `onLinkOpen`, `generateLinkForSelection`, or element-level `onDuplicate` callbacks.

That distinction matters. NIL-659 needs a new supported adapter capability which wraps the
upstream callbacks. It must not attach a document click listener or present the existing CSS
selector as navigation infrastructure.

### Relevant upstream behavior

ExcaliDash pins `@excalidraw/excalidraw` 0.18.1. In that release:

- [`onDuplicate(nextElements, prevElements)`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/types.ts#L493-L508)
  covers mouse duplication, keyboard duplication, paste, and library insertion.
- [`onLinkOpen` and `generateLinkForSelection`](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/types.ts#L532-L538)
  are supported host callbacks.
- The upstream duplication implementation
  [deep-copies the element and regenerates its Excalidraw identity and bindings](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/newElement.ts#L644-L790),
  while arbitrary `customData` is copied unchanged. That behavior is useful but also creates
  duplicate anchor IDs unless the host normalizes the new elements.
- Upstream [PR #8812](https://github.com/excalidraw/excalidraw/pull/8812) added in-canvas element
  links and deliberately leaves application URL/custom-scheme handling to hosts.

The upstream callbacks are evidence for a feasible adapter seam, not a compatibility promise.
The implementation package must lock the observed 0.18.1 cases into adapter tests and real
browser scenarios before depending on them.

## Stable anchor contract

### Target identity

An anchor is an optional target record inside the existing namespace:

```ts
type AnchorRecord = {
  id: AnchorId;              // opaque UUID, stable only within one board
  kind: "frame" | "element";
  contractVersion: 1;
};

customData.excalidash = {
  schemaVersion: 2;
  sticky?: StickyRecord;
  widget?: WidgetRecord;
  anchor?: AnchorRecord;
};
```

This is an additive field in the current namespace, so it does not require a second namespace
or a permanent v2/v3 reader fork. The canonical frontend writer must preserve `anchor` while
writing sticky/widget fields, and the backend copy of the contract must parse the same shape.
Shared fixtures must fail when the accepted records diverge.

The ID choices are deliberate:

- `anchorId` is the durable user-facing reference key.
- `element.id` is only the current Excalidraw locator used after resolution. Upstream changes it
  during duplication and import operations.
- A frame's `name` is presentation: it is mutable and need not be unique.
- `versionNonce` is an edit/collaboration tie-breaker. It changes with element versions and is
  therefore the opposite of identity.
- Board ID scopes an anchor. No global anchor registry is introduced.

Frames are the first authoring UI because they match presentation and workshop mental models.
The contract permits a later generic element anchor without another storage shape.

### Source URI

`element.link` contains one of two canonical references:

```text
excalidash://anchor/v1/self/<anchorId>
excalidash://anchor/v1/board/<drawingId>/<anchorId>
```

The first form is relocatable with its board. The second form names a particular board in the
same ExcaliDash instance. The parser rejects extra credentials, query parameters, fragments,
unknown path forms, invalid UUIDs, or additional schemes. The sanitizer accepts only values
which round-trip through that parser. It does not expand the existing private-scheme allow-list
with a prefix regex.

The URI carries no frame name, username, share token, provider credential, or cached access
result. The displayed label is resolved metadata and may change without changing the link.

### Resolution

Same-board resolution builds an in-memory map from `anchorId` to live, non-deleted element ID.
The map is recomputed from the adapter snapshot on board open and incrementally after debounced
scene changes. Duplicate IDs are an integrity error; the normalizer owns repair during an
authoring operation, while a loaded ambiguous board is reported and not guessed.

Cross-board resolution is a server batch:

```text
POST /api/anchor-resolutions
[{ boardId, anchorId }]
-> [{ reference, state, target? }]
```

The exact route is an implementation detail, but its boundary is not:

1. Resolve every target through `backend/src/authz` with the current authenticated account.
2. Return target metadata only after `canViewDrawing` succeeds.
3. Batch the authz/data lookup; do not add a per-link grant query.
4. Return an access-neutral `forbidden` result. Do not reveal whether a hidden board or anchor
   exists, who owns it, or what it is named.
5. Never accept a share token embedded in a scene. Shared scene data is not a credential store.

Viewer-specific results remain local cache/UI state. They are never written into the shared
element because collaborators may have different access.

### Copy and duplication semantics

Upstream copies arbitrary `customData`, so “anchor IDs survive copy” cannot be the rule. It
would make two targets indistinguishable on one board. The adapter's duplication callback must
normalize the delta as one operation:

| User operation                                          | Result                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicate a target                                      | The duplicate receives a new `anchorId`; existing inbound links continue to point to the original.                                   |
| Duplicate a linked source only                          | Its link continues to point to the original target.                                                                                  |
| Duplicate source and target together                    | The duplicated target receives a new `anchorId`, and the duplicated source is remapped to it. Originals remain linked to each other. |
| Paste into the same board                               | Apply the same delta rule and repair every new collision before the scene is persisted.                                              |
| Paste a complete self-linked cluster into another board | Mint target IDs and remap copied sources within the pasted cluster.                                                                  |
| Paste only a self-linking source into another board     | It becomes unresolved; do not reinterpret `self` as a similarly named target. The UI can offer an explicit repoint action.           |
| Library insertion                                       | Treat the insertion as a new cluster, never as preservation of board-scoped identity.                                                |
| Undo/redo and live collaboration                        | The ID mint and link remap are one scene update so collaborators never observe a permanently half-remapped pair.                     |

The callback supplies previous and next element sets. The implementation may use Excalidraw IDs
to identify the newly created delta, but those IDs do not enter the durable URI. The browser
matrix must cover `Ctrl/Cmd-D`, alt-drag, clipboard paste, cross-board paste, library insertion,
undo/redo, and two-client collaboration.

If the pinned callback cannot deterministically distinguish and atomically remap these cases,
the package stops. Raw element-ID links or name/geometry matching are not acceptable fallbacks.

## Export and import

There are two different portability contracts.

### Single-board `.excalidraw`

The current browser export contains elements, app state, files, and source, but no portable
ExcaliDash board identity map. Therefore:

- `self` links remain meaningful inside the exported board.
- An absolute cross-board link remains an explicit reference to the source instance/board and
  will normally be unresolved after import elsewhere.
- Import preserves that unresolved value so the owner can repoint or remove it. It never binds
  by frame name.
- A future cross-instance representation needs a separate instance identity and trust model;
  NIL-659 does not invent one.

### Full V3 backup

V3 restore intentionally copies every board to a new UUID. In the same transaction which uses
`finalDrawingIdMap` for board rows, assets, files, and snapshots, it must also:

1. Parse every anchor URI in current scenes and snapshots.
2. Leave `self` unchanged.
3. Rewrite absolute board IDs when the target board is included in the archive.
4. Leave an external/not-in-archive target explicit and unresolved.
5. Validate the rewritten URI with the same exact parser before storing it.

The round-trip test must use at least two boards, a link in each direction, a self-link, a
snapshot link, and one deliberately excluded target. Partial database success is not allowed:
failure to parse or remap an included internal target aborts the restore transaction.

## Integrity watcher

### A typed resolver protocol

The common layer owns lifecycle and presentation, not provider semantics:

```ts
type Resolution =
  | { state: "checking" }
  | { state: "valid"; fingerprint?: string }
  | { state: "changed"; previous: string; current: string }
  | { state: "missing"; evidence: "deterministic" }
  | { state: "forbidden" }
  | { state: "unavailable"; retryAfter?: number }
  | { state: "unsupported" };
```

`missing` is red only with provider-specific deterministic evidence. Examples:

- same-board map completed and the unique anchor is absent: red;
- an authorized cross-board lookup found the board but not the anchor: red;
- GitHub says a visible issue is closed or a PR is merged: still valid, with changed metadata;
- GitHub returns `404` for a private object: ambiguous between missing and inaccessible, so not
  red;
- rate limit, timeout, provider outage, stale credentials: unavailable, so not red;
- duplicate anchor IDs: integrity error requiring repair, not a randomly selected valid target.

`changed` requires a typed fingerprint chosen by the resolver, not a generic JSON hash. An
anchor record may store the last explicitly accepted fingerprint. “Accept current” is an
owner/editor action which updates that shared expectation. A viewer-specific access result is
never part of it.

### Where and when it runs

| Resolver                           | Runtime                                           | Triggers                                                               | Cache                                                                       |
| ---------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Same-board anchor                  | Browser, from adapter snapshots                   | Board open; debounced element/link/anchor change; collaboration update | Per-open-board map keyed by scene version                                   |
| Cross-board anchor                 | Backend authenticated batch, requested by browser | Board open; reference set changes; manual retry                        | Short per-user/per-access-cohort TTL; never globally expose private results |
| GitHub reference, if approved      | Backend provider adapter                          | Visible-card open/refresh; TTL expiry; later verified webhook          | Conditional requests plus encrypted credential-scoped cache                 |
| Code symbol, only in a later pilot | Local/repository-aware adapter                    | Explicit refresh or repository revision change                         | Repository/revision/symbol key                                              |

A global cron is not the first implementation: it has no natural viewer identity for private
targets and would continuously spend work on inactive boards. CI is also wrong for user-owned
boards and private provider credentials. A later hygiene worker may revisit only deterministic,
shared failures once the application has a persisted failure clock; it must not turn transient
or viewer-specific states into shared truth.

Provider webhooks are an optimization after a working pull resolver, not the initial source of
truth. GitHub recommends webhooks over high-volume polling, but webhook delivery still requires
a public HTTPS endpoint, signature verification, replay/idempotency handling, repository
installation lifecycle, and a periodic reconciliation path.

### UI and cleanup

Integrity appears through `ui.overlayRoot()` and a board-level integrity panel:

- valid: no permanent canvas decoration;
- changed: amber badge on selection/hover and an entry explaining the old/current value;
- deterministic missing: red broken-link badge and board count;
- forbidden: neutral lock state without target metadata;
- unavailable/checking/unsupported: gray state with retry or explanation.

The available actions are `Open`, `Repoint`, `Accept current` (changed only), and `Remove link`.
Only a board owner/editor may mutate. A viewer may inspect the status but cannot clean it up.
There is no automatic deletion.

For deterministic shared failures only, a future hygiene index may record `firstFailedAt`:

- immediately: visible broken state and manual repair;
- after 30 days: owner/editor hygiene queue and reminder;
- after 90 days: stronger board-level warning, still no automatic removal.

Those ages are impossible to claim from an ephemeral browser cache. The implementation must
either persist the deterministic failure clock with evidence or omit age-based behavior.
Forbidden, rate-limited, timed-out, and ambiguous provider results never enter that clock.

## GitHub live cards (NIL-661)

### What the upstream roadmap actually says

The official Excalidraw+ [roadmap](https://plus.excalidraw.com/roadmap) contains a backlog item
named “Github integration” describing diagrams for pull requests or showing code as drawings.
That supports the existence of a product idea. It does **not** promise live PR/issue cards,
define a storage/API contract, give a delivery date, or provide code that this self-hosted fork
can reuse. GitHub issue [#4242](https://github.com/excalidraw/excalidraw/issues/4242) concerns
saving drawings to GitHub and is not evidence for live cards.

ExcaliDash should therefore not wait for, nor claim alignment with, an unspecified upstream
implementation. It should wait for its own concrete user/display contract.

### If the gate is passed

Use a GitHub App, not a classic OAuth App and not a personal access token pasted into a board.
GitHub's own guidance [prefers GitHub Apps for fine-grained permissions and short-lived
credentials](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).
User access tokens are bounded by both the app installation and the user and can be refreshed
without exposing them to the browser; see GitHub's
[user-access-token contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

Initial permissions are read-only `Metadata`, `Issues`, `Pull requests`, and, only if the card
actually displays them, `Checks`. Do not request `Contents` for an issue/PR status card. Tokens
are encrypted server-side, redacted from logs, never serialized into Excalidraw, and revoked on
disconnect/uninstall. All outbound requests reuse the existing link-preview service's SSRF,
bounded-queue, timeout, and observability disciplines, but provider authentication is a distinct
adapter.

Anonymous GitHub REST calls allow only 60 requests/hour per IP, while authenticated primary
limits are normally 5,000/hour; installation limits can scale. The authoritative numbers and
secondary-limit caveats are in GitHub's
[REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
The design therefore batches visible references, uses ETags/conditional requests, respects
`Retry-After` and rate-limit reset, and caches private results by credential/access cohort.
Public results may share a cache only after the response is proven public.

The stored reference contains provider, repository owner/name, object kind, and numeric ID.
Live title, state, author, checks, and access are resolved data. Closed/merged is not broken;
deleted/inaccessible is neutral unless the adapter can distinguish it without leaking existence.

The package does not start until the product owner names the exact card fields and at least
three of the roughly ten intended team members commit to a real workflow. A four-week pilot
stops if fewer than three people use it weekly or fewer than twenty cards remain active. These
are proposed product thresholds, not facts measured from current telemetry.

## Code and architecture diagrams (NIL-662)

The repository currently contains no Mermaid code block or `.mmd`/`.mermaid` source. That is a
missing convention, not evidence that a canvas-backed documentation system is needed.

GitHub natively [renders Mermaid in Markdown files, issues, pull requests, and discussions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams).
For normative architecture this gives text review, ordinary diffs, repository locality, and a
single source which renders next to the code. The decision is:

- use Mermaid-in-Markdown for maintained system/topology/sequence diagrams;
- keep the Mermaid text as the only source of truth;
- use ExcaliDash for workshops, exploration, presentation, and richer free-form explanation;
- link an exploratory board from a document only when the document clearly labels it
  non-normative;
- do not generate a canvas from code and then hand-edit it. That creates an overwrite hazard
  and two authorities;
- do not claim a watcher detects false topology. At most it can resolve a repository/path/symbol
  pointer and compare its declared fingerprint.

No NIL-662 implementation package is recommended now. A later time-boxed pilot is justified
only when a named architecture document cannot be adequately reviewed as Mermaid. The pilot
must compare review clarity and update cost; if reviewers cannot understand the semantic diff
or the generated/manual boundary is ambiguous, stop and keep Mermaid.

## Nested `AGENTS.md` trial (NIL-663)

The recent failure modes point to paths, not to missing semantic search:

| Location                              | Distinct local rules supported by evidence                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/AGENTS.md`              | Product code reaches Excalidraw only through the canonical adapter; notifications use the facade rather than direct Sonner calls; CSS selectors into Excalidraw are inventoried seams. NIL-628, NIL-614, and NIL-627 crossed multiple frontend subtrees, so a file only inside `integrations/excalidraw` would not have governed the offending call sites. |
| `frontend/src/pages/editor/AGENTS.md` | Editor features receive the one adapter owned by `Editor`; custom data uses the canonical parser/writer; anchored toolbars use the shared primitive; live collaboration needs observable two-client behavior. NIL-628 and NIL-629 are concentrated here.                                                                                                   |
| `backend/AGENTS.md`                   | Board access goes through `src/authz`; frontend/server element contracts move together; Prisma migrations and import/export remaps are atomic and tested. This scope intentionally covers both `src` and `prisma`; NIL-487 showed that a narrower route-local note would miss the contract.                                                                |
| `e2e/AGENTS.md`                       | Collaboration assertions use two real contexts and verify resulting viewport/canvas state, not only button state; visual evidence follows the delivery protocol. NIL-602 is the concrete example.                                                                                                                                                          |

Each file should contain only path-specific rules plus links to the canonical architecture docs.
It must not repeat global Git identity, delivery v2, or generic test commands from the root.
Repository guards remain the enforcement layer; prose explains the boundary and its reason.

Run the trial for ten relevant PRs or two weeks, whichever is later. Review each candidate file
against actual review findings. Merge or remove a nested file if it has no unique rule, conflicts
with the root, or was stale when needed. Do not build embeddings or an instruction router unless
this small hierarchy first produces measured misses that path scoping cannot solve.

## Cost and benefit

| Scope                        | Benefit                                              | Main cost/risk                                                           | Decision                                         |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Same-board frame anchors     | Direct workshop/navigation value; local and testable | Duplication semantics and adapter callback contract                      | Build first, with abort gate                     |
| Cross-board anchors          | Team-space navigation across canvases                | Authz non-disclosure, batching, backup portability                       | Build second only after local identity is proven |
| Common watcher               | One honest status vocabulary and cleanup UI          | Premature abstraction and false-red risk                                 | Extract after two concrete resolvers             |
| GitHub cards                 | Useful live project context for a subset of boards   | Credentials, rate limits, private cache partitioning, webhook operations | Gated pilot, not current base scope              |
| Code/diagram synchronization | Potentially attractive visual docs                   | Second source of truth; impossible semantic-truth promise                | Reject for now; use Mermaid                      |
| Nested guidance              | Cheap prevention at known seams                      | Stale/repeated prose                                                     | Four-file measured trial                         |

## Migration packages and abort criteria

These are proposed ownership packages, not current Acceptance Slices or dispatches. Each must be
routed through delivery v2 with real metadata before implementation.

### Package 1 — Same-board frame anchors

Add the anchor field to the canonical frontend/backend contract, exact URI parser/sanitizer,
adapter-wrapped link-open/link-generation/duplication callbacks, frame-link authoring, local
resolution, and the real-browser duplication matrix. Remove any experimental raw-element-ID
path in the same package.

**Exit:** self links survive save/reload, full-scene replacement, all duplication/paste cases,
undo/redo, and two-client collaboration without a duplicate anchor or transient wrong target.

**Abort:** the pinned upstream callback cannot deterministically identify and atomically remap
all new source/target pairs. Do not fall back to element IDs, names, geometry, DOM listeners, or
dual storage.

### Package 2 — Cross-board resolution and portable backup

Add absolute board references, one authz-owned batch resolver, neutral per-viewer access states,
server cache partitioning, V3 current-scene and snapshot remapping, and two-board round-trip tests.

**Exit:** an authorized user navigates; an unauthorized user learns no target existence or
metadata; included V3 targets remap to copied boards; excluded/single-file targets stay explicit
and unresolved.

**Abort:** any route bypasses `backend/src/authz`, any response distinguishes a hidden object
from a nonexistent one, or a complete V3 backup cannot remap every included reference
transactionally. No name-based repair is allowed.

### Package 3 — Shared integrity lifecycle and hygiene

After the local and cross-board resolvers exist, extract the typed state machine, board panel,
retry/cache lifecycle, deliberate repair actions, and persisted age only for deterministic
shared failures.

**Exit:** the two resolvers pass the same conformance suite; injected timeout/rate-limit/access
failures never appear red; only proven missing targets accrue cleanup age.

**Abort:** the second resolver needs materially different meanings for `missing`, `changed`, or
access visibility, or the failure clock cannot be tied to deterministic evidence. Keep resolver
UI local instead of forcing a dishonest universal abstraction.

### Package 4 — GitHub live-card pilot (conditional)

Only after the usage/display gate, add GitHub App connection lifecycle, encrypted server tokens,
minimal read permissions, provider resolver, conditional cache, rate-limit UI, and uninstall/
revocation tests. Webhooks are a later coherent slice after pull reconciliation works.

**Exit:** public and private fixtures prove cache isolation; revoked tokens stop access; merged
and closed objects stay valid; ambiguous `404`, rate-limit, and outage are not red.

**Abort:** the named adoption gate is not met, required fields need repository `Contents` or
write permissions without a separately approved product case, private results can cross a user
boundary, or the four-week pilot misses the proposed usage thresholds.

### Package 5 — Normative diagram convention, no canvas synchronizer

Document Mermaid-in-Markdown as the normative diagram convention and migrate one suitable
architecture diagram only when a real document needs it. ExcaliDash remains explicitly
exploratory for this use case.

**Exit:** reviewers can assess the diagram from the PR diff and the text source is the single
authority.

**Abort:** if Mermaid cannot express the named case, record that case and evaluate a time-boxed
manual ExcaliDash pilot; do not silently start a generator/watcher project. If the pilot produces
an ambiguous source-of-truth boundary, stop it.

### Package 6 — Path-local guidance trial (independent)

Add the four proposed nested files with only the measured local rules and architecture links.
Do not add a router, embeddings, generated summaries, or duplicate global policy.

**Exit:** after ten relevant PRs/two weeks, every retained file has at least one unique current
rule and no contradiction with the root or repository guards.

**Abort:** remove or merge any file which merely repeats the root, is stale at review time, or
cannot be scoped to its directory. A failed small trial is evidence against adding retrieval
infrastructure, not evidence for it.

## Recommended order

```text
Package 1: local identity + navigation
    -> Package 2: cross-board authz + backup remap
        -> Package 3: shared watcher + hygiene
            -> Package 4: GitHub pilot, only if its product gate passes

Package 5: Mermaid convention, no runtime dependency
Package 6: nested-guidance trial, independent and reversible
```

This order keeps the stable identity decision ahead of provider integrations, proves two
resolver types before abstraction, and lets the cheap documentation decisions proceed without
claiming that they solve live-reference correctness.
