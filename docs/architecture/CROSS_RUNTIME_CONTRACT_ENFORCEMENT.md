# Cross-runtime contract enforcement (NIL-635)

Status: planning decision, awaiting Davi's approval. This document does not ship an
enforcement check or production code.

Measured on 2026-08-26 against `main` at
`caf3ed979bc8b770b6af1b9e44cc2abe04a32691` and the final reference head of PR
[#203](https://github.com/davifernan/excalidash/pull/203),
`334b505676f1295272122aaa80ffea7257d782a7`. PR #203 stays open as evidence and must not be
merged. Timing probes used the repository's required Node line, Node v24.19.0.

## Decision

Do not continue the repository-wide duplicate-shape detector from PR #203. Do not replace it
with a blanket ban on TypeScript declarations outside `packages/domain` either.

Use a narrower combination:

1. A private workspace package is the canonical home for cross-runtime runtime schemas,
   vocabularies, constants, and deterministic algorithms.
2. Contract types are inferred from those runtime values. A derived alias such as
   `z.infer<typeof sharedSchema>` is a consumer, not a second source.
3. Raw cross-runtime transports are private to high-level adapters. Product code cannot receive
   a raw Socket.IO socket, construct a protocol Worker, or supply an arbitrary schema to a
   handler registration. It uses an adapter whose event/request registry is inferred from the
   canonical package.
4. CI forbids raw transport dependencies/imports and leaked raw handles outside those adapter
   homes. It does not try to recognize semantically equivalent TypeScript declarations.
5. Exact behavioral countertests exercise the real adapters for shared algorithms and failure
   policy. Opaque/branded parsed values may add compile-time friction inside the adapter APIs,
   but they are defense in depth, not the enforcement boundary.
6. Treat finite seam ownership as a reusable architecture pattern across and within runtimes,
   but keep each capability's home and guard separate. This package does not create a universal
   seam detector or absorb the existing Excalidraw, notification, CSS, or component boundaries.

This confirms the hypothesis in NIL-635 only after narrowing it. A prohibition is tractable
when it says "only this finite adapter may own this raw capability." The broader statement
"outside `packages/domain` nobody may declare this contract" still needs a detector to decide
what "this contract" means and inherits the original completeness problem.

The intended guarantee is therefore:

> An accidental second implementation cannot become executable at a protected cross-runtime
> seam without either failing the dependency/adapter boundary or changing the boundary itself
> in an obvious, independently reviewed diff.

It is deliberately not:

> No unused, structurally similar declaration can exist anywhere in the repository.

The second claim is neither necessary for runtime correctness nor completely decidable for
arbitrary TypeScript programs.

## Observed benefit: what this would and would not have caught

The user feedback represented by NIL-601 through NIL-632 on 2026-08-26 is not evidence for this
proposal. Counting the reports rather than classifying them by impression gives **0** cases that
the cross-runtime chain in this document would have prevented. They were UI, UX, or
single-runtime failures: for example, one follow path did not call `collaboration.follow`, while
an old board produced "Document Widget is not part of the board." Neither was disagreement
between independently executed contract implementations.

Across all findings that day, exactly one belongs to this document's category: NIL-624. The
backend exposed one document page while the frontend exposed three and then sent page numbers
the server rejected. It came from sweep NIL-613, not from user feedback. The strongest additional
motivation is therefore a near miss, not a reported incident: while removing Mind Map fields,
the backend copy of the `customData` schema was almost left behind. Hans-Friedrich found the copy;
no automated boundary did.

That is a narrow evidence base: **0 prevented user reports, 1 discovered cross-runtime defect,
and 1 cross-runtime near miss** on the measured day. It does not justify a repository-wide
detector. It does justify fixing NIL-624 independently and testing whether finite ownership can
make the same class of near miss mechanically visible at the seams where the cost is bounded.

Four other same-day duplication findings were real but inside one runtime: NIL-628's second live
adapter in follow mode, NIL-629's independently built inner markup for each floating element bar,
NIL-614's 80 direct Sonner calls, and NIL-627's CSS seams outside the inventory. The proposed
cross-runtime package would have caught **none** of them. They test whether seam ownership is a
useful broader principle; they are not retroactive benefit attributed to this package.

## Why PR #203 is evidence, not a delivery candidate

The shared-package direction worked. In particular, its pagination path made 50,000 unbroken
characters produce exactly three pages in both runtimes. The generalized guard did not work as
a durable proof.

Hans-Friedrich reviewed three successive heads and found a new hole in the same file each time:

| Reviewed head | Hole in `scripts/domain-boundary.cjs`                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `6dc84d3`     | Short object aliases and two-branch unions did not reach the weight threshold.                                        |
| `f19da55`     | Pure callables skipped both name and shape checks; interface and type-literal shapes were normalized differently.     |
| `334b505`     | Intersection, mapped, conditional, generic-reference, and `z.infer`-shaped aliases remained low-weight and invisible. |

The final head contains 195 lines of detector and 183 lines of counterprobes. It checks 1,440
exported declarations. Twenty warm runs on this host measured 669.1--987.4 ms, median 724.0 ms
and p95 847.6 ms. Its existing counterprobe suite took 5,171.0 ms.

Runtime is acceptable for CI. Completeness and maintenance are not: three reviews expanded the
enumeration three times, while the final counterprobes still did not include the third review's
missing forms.

The PR also mixed the architecture change with behavioral changes. In particular, several
per-entry checks became whole-array Zod parses. One invalid follower, presence entry, or
selection entry could then discard the complete update. Contract centralization must preserve
failure policy, not merely field shape.

## What "the contract" means

A cross-runtime contract is a decision for which two independently deployed or separately
executed components must agree in order for the same input or message to retain its meaning.
It belongs in the canonical package when it is one of the following:

- a serialized request, response, event, worker message, persisted value, or its runtime schema;
- an event name, discriminator, limit, enum-like vocabulary, or default that changes how such a
  value is interpreted;
- a deterministic algorithm whose result must agree between runtimes, such as document
  pagination;
- the failure policy at the boundary: reject the whole value, drop an invalid entry, substitute
  a default, or surface an error.

The definition is based on an observable seam, not on syntax. The following are not independent
contract sources:

- `z.infer<typeof canonicalSchema>`;
- `Pick`, `Omit`, `Partial`, an intersection, or a view type derived only from canonical imports,
  provided it adds no new wire constraint;
- a local UI model that never crosses a runtime seam;
- a helper whose result is not required to agree across runtimes;
- an unused Zod schema. That is dead code, not a contract merely because it uses Zod.

A derived type becomes a new contract source when it adds a literal, field, limit, default,
refinement, transformation, or failure behavior that a different runtime must independently
reproduce. It then moves into the canonical package as a named schema/value or remains local and
must not be used at the shared seam.

This definition avoids a mistake visible in PR #203: moving every similar DTO into one package
can remove useful local relationships. `PublicPresenceEntry`, for example, lost its structural
derivation from the private server presence entry, weakening a compile-time safeguard against
leaking new private fields. A public wire schema and a server projection assertion solve
different problems; centralizing the first must not delete the second.

## Measured option comparison

### 1. Handwritten AST duplicate detector from PR #203

The probe copied each definition under a different name from the domain home into an application.
That removes the easy duplicate-name signal and measures the advertised shape guarantee.

| Form                                          | Final #203 detector |
| --------------------------------------------- | ------------------- |
| Object literal                                | red                 |
| Interface equivalent to a type literal        | red                 |
| Union                                         | red                 |
| Function with the same body                   | red                 |
| Intersection                                  | green               |
| Mapped type                                   | green               |
| Conditional type                              | green               |
| Generic reference                             | green               |
| Exported Zod schema                           | red                 |
| `z.infer` from an unexported duplicate schema | green               |

Result: 5/10 red. Adding five more syntax branches would only move the edge. It would not prove
that the next type form, normalization difference, alias chain, overload, declaration merge, or
semantically equivalent function body is covered.

### 2. TypeScript-checker semantic equivalence

A disposable compiler probe compared mutual assignability rather than handwritten text shapes.
It took 320.3 ms on the synthetic matrix and found 8/10 forms. Generic mapped and conditional
types still needed instantiation choices and stayed unmatched.

The same probe marked all four deliberately unrelated pairs as duplicates: two different ID
concepts represented by `string`, two unrelated geometric concepts with `{ x; y }`, two
unrelated callbacks with `(string) => string`, and two DTOs from different boundaries with the
same optional field.

Result: broader detection trades false green for false red. Function type equivalence is also
not function behavior equivalence. A baseline or exception mechanism would then be required,
and the project would again maintain a second, growing classification of its contracts.

### 3. Blanket declaration prohibition

A prohibition on every exported type, interface, enum, function, constant, and class outside
the domain package is syntactically complete. On the already migrated #203 tree it would reject
1,456 application declarations across 437 source files:

| Kind                                 | Existing declarations rejected |
| ------------------------------------ | -----------------------------: |
| Type alias                           |                            284 |
| Interface                            |                             41 |
| Function                             |                            109 |
| Exported variable/constant statement |                            996 |
| Class                                |                             26 |

Restricting that prohibition to the 151 names exported by the domain package produces zero
violations on the migrated tree, but a rename bypasses every row of the counterexample matrix.

Result: the broad version has an unusable false-red rate; the narrow name-based version is
incomplete.

### 4. Generation from one source

Generating TypeScript copies for both applications would guarantee byte-identical generated
output, but it would not stop either consumer from bypassing the generated file. It also adds
generation ordering, Docker-context, watch-mode, and stale-output concerns.

Prefer inference from live runtime values in a workspace package: one Zod schema/registry value
produces its TypeScript types without checked-in generated copies. Generation remains useful for
mechanical client/server adapters if a registry becomes too repetitive, with a mandatory
"regenerate and require a clean diff" test. It is not itself the boundary.

### 5. Opaque/branded types

A disposable TypeScript probe wrapped each of the ten forms in an inaccessible `unique symbol`
brand. All 10/10 accidental structural substitutions failed compilation in 343.8 ms. The same
values passed with an explicit type assertion, and a value typed `any` also passed with zero
diagnostics.

Result: brands usefully stop accidental substitution after canonical parsing/construction. They
cannot prove sole origin in TypeScript and do not stop a second declaration or implementation.

### 6. Finite seam ownership (recommended)

The final #203 tree contains these raw seam sites by a conservative text inventory:

| Seam family                                | Calls/registrations | Files |
| ------------------------------------------ | ------------------: | ----: |
| Socket.IO `socket`/`io` `.on` and `.emit`  |                  82 |    23 |
| Worker construction/message operations     |                   5 |     3 |
| Express `router`/`app` route registrations |                 123 |    43 |

This is not yet the migration list: connection lifecycle events and server-only routes do not
all carry shared product contracts. It establishes that the protected set is a finite set of
capabilities and call sites, rather than 1,440 declarations whose semantics have to be guessed.

As local cost references, existing home-based boundary checks measured over twenty runs at:

| Existing boundary       |   Median |      p95 |
| ----------------------- | -------: | -------: |
| Backend logging home    |  40.5 ms |  53.6 ms |
| Authorization home      |  61.6 ms |  79.5 ms |
| Notification home       |  94.0 ms | 113.7 ms |
| Excalidraw adapter home | 106.2 ms | 124.8 ms |

Those checks are not implementations of this proposal, so their times are not a promised result.
They show the cost class of checking a finite ownership boundary. A future contract-boundary
check should have a 250 ms local median budget and must be measured before admission.

## Does finite seam ownership generalize within one runtime?

Yes as an architecture pattern; no as one generalized guard. The reusable rule is:

1. Name a finite raw capability and one owner home.
2. Give consumers a higher-level facade or capability instead of the raw handle, import,
   selector, or construction recipe.
3. Prevent the raw capability from escaping that home.
4. Add a zero-baseline counterprobe that deliberately crosses that particular boundary and is
   observed to fail.

The same-day cases separate clean applications of that rule from a merely related case:

| Test case                                        | Would finite ownership apply?                                                                            | Correct boundary                                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NIL-628: second live adapter in follow mode      | Yes. Raw Excalidraw access and adapter construction are finite capabilities.                             | `adapter-boundary` keeps package access, raw editor behavior, and construction in the Excalidraw integration home.                                                                      |
| NIL-614: 80 direct Sonner calls                  | Yes. Importing Sonner is the finite raw capability.                                                      | `notification-boundary` permits that import only in the notification facade; callers express severity and content through `notify()`.                                                   |
| NIL-627: CSS seams outside the inventory         | Yes, with a selector-specific proof. A selector targeting foreign internals is the raw capability token. | The CSS inventory stays owned by the Excalidraw integration and `adapter-boundary` requires exact, complete inventoried selectors. A generic import guard would not prove this.         |
| NIL-629: separate inner markup for floating bars | Related, but not automatically. Similar JSX has no finite raw dependency or token.                       | Give the markup one canonical component/renderer when the product requires one representation, then test its behavior and visuals. Do not revive shape- or markup-similarity detection. |

The existing `adapter-boundary`, `notification-boundary`, and CSS seam inventory are therefore
instances of **one ownership pattern with separate enforcement mechanisms**. Combining them into
one script would save little: the Excalidraw check reasons about package imports, raw APIs, DOM
selectors, synthetic events, and `customData`; the notification check reasons about all static
and dynamic Sonner import forms; the CSS check needs full-selector boundaries and an explicit
inventory. A common engine would either expose capability-specific plug-ins that are still three
guards, or grow into the same open-ended syntax enumeration that failed in PR #203.

NIL-629 marks the stopping point. A boundary is enforceable when the raw capability or canonical
construction entry is finite. "No independently similar implementation anywhere" is not such a
boundary. Component ownership may instantiate the pattern after a canonical renderer exists,
but searching arbitrary JSX for semantic duplication must remain out of scope.

The notification merge on 2026-08-26 is measured positive evidence for the pattern. PR #200
made Sonner private behind `notify()` and removed a direct import. PR #211 had branched earlier
and added another `toast.error` on a different line. Git reported no textual conflict when the
changes were collected; the protected boundary made the semantic conflict fail admission instead
of landing silently. The immediate symptom was an unresolved `toast` reference after #200's
import removal, while `notification-boundary` also prevents resolving it by restoring a direct
Sonner import outside the facade. The subsequent fix routed the call through `notify()`.

This evidence supports capability-specific prohibitions once a home exists. It does not support
widening NIL-635: cross-runtime schemas and transports have deployment-skew, decode-policy, and
bidirectional-adapter risks that the three frontend boundaries do not. Keep this document's
implementation packages cross-runtime-specific, and reuse the four-step ownership test when a
different package proposes a bounded intra-runtime seam.

## Target shape

### Canonical package

`@excalidash/domain` owns domain values, not application adapters:

- Zod schemas and a direction-aware registry for wire payloads;
- types inferred from those schemas;
- event names, discriminators, limits, and defaults used by more than one runtime;
- pure deterministic implementations such as pagination;
- an explicit decode policy for collection payloads (`reject-whole` or `drop-invalid-entry`).

The registry value, rather than a parallel interface, is the source from which client and server
event maps are inferred. A schema is not accepted as a parameter at product call sites; otherwise
a consumer can silently supply a local replacement.

### Transport adapters

One high-level adapter per transport owns the raw dependency and raw handle. For collaboration,
the server adapter registers the canonical event registry and gives product handlers already
parsed values. The client adapter emits and receives through the same registry. Neither exports
its underlying Socket.IO socket.

The same pattern applies to the pagination Worker: its request/response schema and pagination
function come from the canonical package, while one frontend adapter owns `new Worker`,
`onmessage`, and `postMessage`. Product code receives only `paginateDocumentOffThread`.

HTTP should follow only after an inventory distinguishes genuinely shared request/response
contracts from backend-only routes. A later HTTP adapter may infer a client from a route registry;
NIL-635 does not justify moving all 123 measured route registrations.

### Dependency boundary

The target structure must make raw access absent, not merely renamed:

- only the transport-adapter package/module declares the raw transport dependency;
- application packages do not declare that dependency and may not import it statically,
  dynamically, through `require`, or through a re-export;
- raw handles and raw transport types are not part of adapter exports, callbacks, React context,
  or constructor parameters;
- the domain package cannot import either application;
- application-to-application imports remain forbidden.

Package manifests, package exports, TypeScript project references, and the existing lint/build
graph should carry as much of this as possible. A small CI assertion checks the dependency graph
and public exports. It must not infer ownership from receiver variable names such as `socket`.

This is the key completeness improvement. If a raw handle is passed throughout the product, a
guard has to enumerate every way it can be called. If it never leaves its home, the rest of the
repository has no runtime capability to register a competing contract.

## Completeness claim and its limits

The proof is constructive and scoped to executable seams:

1. Every protected transport instance is constructed in one adapter home.
2. That adapter does not export the raw instance or accept caller-provided schemas.
3. Every protected handler registration is derived from the canonical registry.
4. Incoming values are parsed there; outgoing values are constructed there.
5. Shared deterministic behavior is called inside the adapter from the canonical package.
6. Product code lacks the raw dependency/capability needed to wire a second implementation.

Under these premises, the syntax used to describe a competing type is irrelevant. It can be an
object, interface, union, function, intersection, mapped or conditional type, generic reference,
Zod schema, or `z.infer`: it cannot become the registered wire/worker contract without crossing
the same raw-capability boundary.

The premises are what counterprobes must attack. A proof suite must demonstrate that each of the
following changes turns CI red:

- add a raw transport dependency/import outside its home;
- export or pass out a raw handle;
- register an event or Worker handler outside the adapter;
- add a registry event without exhaustive client/server adapter handling where both are required;
- replace the canonical pagination call in the real server or Worker path;
- replace the canonical parser with a local schema;
- change `drop-invalid-entry` to whole-array rejection for presence, followers, or selections.

No repository-local mechanism can stop a deliberately hostile contributor who changes the
boundary, its tests, and CI in the same approved change. Type assertions, `any`, dynamic code,
or a newly introduced raw network stack can also express an intentional bypass. The realistic
goal is that such a change is explicit and reviewable, not that TypeScript becomes a security
sandbox.

Changes to the canonical registry, transport adapter public surface, dependency rule, or its
counterprobes therefore require the package's high-risk independent review. This is the review
part of the completeness argument; CI alone is not.

## Counterexample matrix for the recommended approach

"Red" below means an independently defined form is used to replace or register the protected
cross-runtime contract. Merely declaring an unused lookalike is intentionally green.

| Form                                | Must become red when wired at the seam | Evidence mechanism                                                              |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Object literal                      | yes                                    | raw registration is forbidden; adapter requires canonical parsed value          |
| Interface                           | yes                                    | same; declaration syntax is not inspected                                       |
| Union                               | yes                                    | same; event map is inferred from the registry                                   |
| Function                            | yes                                    | raw registration is forbidden and real-consumer behavioral test compares output |
| Intersection                        | yes                                    | same; no weight or AST-kind branch exists                                       |
| Mapped type                         | yes                                    | same                                                                            |
| Conditional type                    | yes                                    | same                                                                            |
| Generic reference                   | yes                                    | same                                                                            |
| Zod schema                          | yes                                    | adapter does not accept a caller-provided schema                                |
| `z.infer` from a local schema       | yes                                    | local value cannot enter the branded/parsed adapter path                        |
| `z.infer` from the canonical schema | no, intentionally                      | this is a consumer of the sole source                                           |

This matrix is complete relative to the stated seam premises because all rows exercise the same
capability edge. Adding a new TypeScript type form does not add a new way to obtain a Socket.IO
connection or register a Worker handler.

## Cost and false-red policy

The recommended approach moves cost from a global pairwise scan into a one-time adapter migration.
That migration is real product work: collaboration reconnect, partial-invalid-entry behavior,
acknowledgements, and deployment skew require browser and adversarial coverage.

Steady-state CI should be cheaper and quieter:

- dependency/public-export boundary: target median under 250 ms;
- registry exhaustiveness: compile-time or focused unit test, proportional to registry size;
- exact pagination contract: focused real server/Worker test for both `TEXT` and `MARKDOWN`;
- no repository-wide shape comparison and no collision baseline.

A false red must mean an actual ownership edge was crossed: a raw dependency/import, raw handle
leak, unregistered event, or changed behavior at a real consumer. Local types with similar shapes
must not fail CI. If a proposed rule needs a growing list of legitimate TypeScript declarations,
the rule is rejected before rollout.

## Migration packages

### Package 1: extract and ship the pagination fix

This should be an independent ownership package that closes NIL-624 before broader collaboration
contract work.

Its behavior path in #203 spans nine files with 165 additions and 330 deletions (495 lines of
churn): the canonical document implementation/schema, backend consumer and exact contract test,
the real frontend Worker/client tests, and the visible collaboration assertion. It has independent
user value: 50,000 characters must produce exactly three pages in both production consumers.

The shared workspace foundation is a separate source of review size. In #203 the foundation commit
touched 30 files and 33,657 lines; 32,370 lines (96.2%) were the three lockfiles. That is mostly a
one-time dependency-layout rewrite, but it still carries Docker/install risk and must be reviewed
as such. A minimal extraction should establish `@excalidash/domain` with only `documents/`, not
preload all 27 claimed families.

Acceptance must include:

- exact three-page assertions through the real backend and real Worker for 50,000-character
  `TEXT` and `MARKDOWN` fixtures;
- byte-identical pages, not only equal counts;
- a deliberately truncated Worker result turns the test red;
- Docker, local install, production build, and worker bundle-size evidence;
- removal of both old pagination implementations in the same package.

Do not bring the generalized duplicate detector into this package. The production consumers'
direct imports and exact behavior tests provide the focused proof.

### Package 2: collaboration registry and transport ownership

Define the canonical event registry and high-level client/server adapters, then migrate the 23
measured Socket.IO files by coherent protocol group. Keep one owner session and serial PRs only if
the reconnect/ack risk requires a separate review boundary.

Before each group moves, record its existing invalid-input policy. Presence, followers, and
selection snapshots must retain per-entry tolerance unless a separate product decision explicitly
changes it. Whole-message commands may remain atomic. Remove the old registration path in the same
slice; no compatibility adapter or feature flag remains.

The package is complete only when raw Socket.IO handles no longer leave the adapter and the raw
dependency boundary has zero exceptions.

### Package 3: contract inventory at remaining seams

Inventory HTTP and other worker/persistence seams from registrations outward. Move only artifacts
that satisfy this document's contract definition. Do not start from a global list of similar type
declarations.

For each candidate, record:

- seam and direction;
- canonical runtime value/schema/algorithm;
- existing producer and consumer;
- invalid-input and rollout-skew behavior;
- exact real-consumer countertest;
- whether a local derived type remains useful.

If the inventory shows little repeated behavior after collaboration and pagination, stop. The
measured benefit, not a goal of emptying every local DTO, decides whether this package proceeds.

## Explicitly rejected migration tactics

- Merging or continuing PR #203.
- Adding more TypeScript syntax branches to `domain-boundary.cjs`.
- Treating equal names or shapes as proof of equal domain meaning.
- Moving all similar DTOs into the shared package without identifying a runtime seam.
- Replacing per-entry handling with whole-array parsing as an incidental refactor.
- Checking in generated application copies as a second editable path.
- Using brands as the sole enforcement mechanism.
- Keeping old and new protocol paths behind a permanent compatibility flag.

## Approval gates

No implementation package should start until Davi approves these four decisions:

1. Runtime seam ownership, rather than repository-wide duplicate detection, is the enforcement
   target.
2. The minimal shared workspace/package may land first with the pagination fix despite the
   one-time lockfile and Docker/build churn.
3. Collaboration migration must preserve each event family's failure policy and may not use
   whole-array Zod parsing as a mechanical replacement for per-entry validation.
4. Finite seam ownership is the shared architecture principle, but cross-runtime enforcement and
   intra-runtime capability guards remain separately scoped and capability-specific.

If any gate is rejected, the valid fallback is no generalized guard: ship only the focused
pagination correction with exact cross-runtime tests. The measurements do not justify maintaining
#203's detector for the protection it currently provides.
