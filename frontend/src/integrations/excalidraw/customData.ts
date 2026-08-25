/**
 * The one shape ExcaliDash writes onto an Excalidraw element, and the one
 * place that writes it.
 *
 * Before this there were two incompatible conventions. Sticky notes nested
 * their record under `customData.excalidashSticky` and versioned it with `v`.
 * Document widgets wrote three fields flat at the top level and versioned them
 * with `schemaVersion` -- and the reader required customData to have exactly
 * three keys, so an element could not carry both. That was not a design; it
 * was a key count standing in for a schema.
 *
 * One namespace, one version, one parser, one writer:
 *
 *   customData.excalidash = {
 *     schemaVersion,
 *     sticky?,
 *     widget?,
 *     nodeState?
 *   }
 *
 * Authority stays on the server. Comments, permissions and authorship are
 * never stored here; at most a stable reference to them.
 *
 * ## The mind-map relationship layer is gone (NIL-593, Schnitt 2)
 *
 * `mindMap` (`mapId`/`parentId`/`orderKey`) and `mindMapProjection` used to
 * be the authoritative tree structure for the mind-map tool's own mode.
 * That mode is torn down: structure now comes ambiently from Excalidraw's
 * own arrow bindings (`frontend/src/ambientTree/`), and nothing reads
 * `mapId`/`parentId` as structure anymore, from this file or anywhere else.
 * Neither field is parsed, written, or round-tripped here any longer -- an
 * old element that still carries them in its stored JSON keeps carrying
 * them (nobody deletes historical data), but this module no longer looks
 * at them, so they cannot be misread as structure and a patch that touches
 * an unrelated field on the same element naturally lets them fall away
 * (`withExcalidashData` no longer preserves a key it doesn't know).
 *
 * `pinned`/`collapsed` were never structure -- per-node facts a node can
 * carry independent of who its parent is -- and the ambient version still
 * needs them (Schnitt 3). They move to a new, slim sibling field,
 * `nodeState`, decided and recorded as a NIL-593 comment (measured against
 * Excalidraw's own customData contract): same storage shape as before,
 * freed of the structural fields that died with `mindMap`, renamed because
 * it now applies to any bound node, not one inside a "mind map".
 * `readNodeState` below falls back to the dying `mindMap.pinned/collapsed`
 * shape ONCE, by raw field access (never through a removed structural
 * parser), so an existing board's pin/collapse preference is not silently
 * lost the moment this ships -- every future write goes to `nodeState`
 * only; there is no ongoing dual path.
 */

export const NAMESPACE = "excalidash";
export const SCHEMA_VERSION = 2;

export type StickyRecord = {
  readonly color: string;
  readonly ink: string;
  /**
   * The size the note is meant to be, kept apart from the element's own
   * width/height: Excalidraw grows a container to fit its label before this
   * code sees the change, and without a remembered size each growth would
   * become the new target and the note would creep downwards forever.
   */
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
};

export type WidgetKind = "pdf" | "markdown" | "text";

export type WidgetRecord = {
  readonly kind: WidgetKind;
  readonly assetId: string;
};

/**
 * Per-node facts that outlive the mind-map tool's own dead structure layer
 * (NIL-593, Schnitt 2): whether this node is pinned against the next
 * "Arrange" layout run, and whether its own subtree is collapsed. Neither
 * is structure -- a node's pin/collapse state does not say who its parent
 * is -- so both survive the teardown of `mapId`/`parentId`/`orderKey`
 * unchanged in shape, just freed of the fields that died with them. See
 * this file's own header comment for the decided migration.
 */
export type NodeStateRecord = {
  /**
   * This node's current position is a hand-set one an explicit "Arrange"
   * run must not discard. Missing/`false` means the position is free for
   * the deterministic layout core to recompute.
   */
  readonly pinned?: boolean;
  /**
   * This node's own subtree is collapsed for viewers of this feature. The
   * descendant elements themselves are never touched by this flag -- it
   * only ever drives a client-local overlay that visually masks them; a
   * client without the feature (or a plain JSON export) still sees the
   * complete, unmodified subtree, exactly as NIL-570's own "an element may
   * carry data belonging to somebody else" reading rule already promises
   * for every other field here.
   */
  readonly collapsed?: boolean;
};

export type ExcalidashData = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sticky?: StickyRecord;
  readonly widget?: WidgetRecord;
  readonly nodeState?: NodeStateRecord;
};

export type ExcalidashDataPatch = {
  readonly sticky?: StickyRecord | null;
  readonly widget?: WidgetRecord | null;
  readonly nodeState?: NodeStateRecord | null;
};

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const WIDGET_KINDS: readonly WidgetKind[] = ["pdf", "markdown", "text"];

const parseSticky = (value: unknown): StickyRecord | undefined => {
  if (!isBag(value)) return undefined;
  const color = str(value.color);
  const ink = str(value.ink);
  const width = num(value.width);
  const height = num(value.height);
  const fontSize = num(value.fontSize);
  if (color === null || ink === null || width === null || height === null || fontSize === null) {
    return undefined;
  }
  return { color, ink, width, height, fontSize };
};

const parseWidget = (value: unknown): WidgetRecord | undefined => {
  if (!isBag(value)) return undefined;
  const kind = WIDGET_KINDS.find((candidate) => candidate === value.kind);
  const assetId = str(value.assetId);
  if (!kind || assetId === null) return undefined;
  return { kind, assetId };
};

const parseNodeState = (value: unknown): NodeStateRecord | undefined => {
  if (!isBag(value)) return undefined;
  const pinned = value.pinned === true;
  const collapsed = value.collapsed === true;
  if (!pinned && !collapsed) return undefined;
  return { ...(pinned ? { pinned: true } : {}), ...(collapsed ? { collapsed: true } : {}) };
};

/**
 * Read this application's data off an element.
 *
 * Every field is named and nothing is said about the ones that are not: an
 * element may legitimately carry data belonging to somebody else, and the
 * reader has no business rejecting it for that.
 */
export const readExcalidashData = (element: unknown): ExcalidashData | null => {
  if (!isBag(element)) return null;
  const bag = element.customData;
  if (!isBag(bag)) return null;
  const own = bag[NAMESPACE];
  if (!isBag(own) || own.schemaVersion !== SCHEMA_VERSION) return null;

  const sticky = parseSticky(own.sticky);
  const widget = parseWidget(own.widget);
  const nodeState = parseNodeState(own.nodeState);
  if (!sticky && !widget && !nodeState) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(sticky ? { sticky } : {}),
    ...(widget ? { widget } : {}),
    ...(nodeState ? { nodeState } : {}),
  };
};

export const readSticky = (element: unknown): StickyRecord | null =>
  readExcalidashData(element)?.sticky ?? null;

export const readWidget = (element: unknown): WidgetRecord | null =>
  readExcalidashData(element)?.widget ?? null;

/**
 * Pin/collapse state for a node (NIL-593, Schnitt 2). Falls back ONCE to
 * the dying v1 `mindMap.pinned/collapsed` shape when `nodeState` itself is
 * absent -- by raw field access on the stored bag, never through a
 * structural parser (there is none left) -- so an existing board's
 * preference is not silently lost the moment this ships. Every future
 * write goes through `withExcalidashData`'s `nodeState` only; this is the
 * one place that still looks at the old shape, and only for these two
 * booleans, never for `mapId`/`parentId`.
 */
export const readNodeState = (element: unknown): NodeStateRecord | null => {
  const own = readExcalidashData(element)?.nodeState;
  if (own) return own;

  if (!isBag(element)) return null;
  const bag = element.customData;
  if (!isBag(bag)) return null;
  const excalidash = bag[NAMESPACE];
  if (!isBag(excalidash)) return null;
  return parseNodeState(excalidash.mindMap) ?? null;
};

/**
 * Produce the customData bag for an element carrying this data.
 *
 * Foreign keys on the element are preserved; only this namespace is replaced.
 * The caller applies the result -- this function does not mutate anything,
 * because an element handed in from the editor is not ours to change.
 */
export const withExcalidashData = (
  element: unknown,
  data: ExcalidashDataPatch,
): Record<string, unknown> => {
  const existing = isBag(element) && isBag(element.customData) ? element.customData : {};
  const previous = isBag(existing[NAMESPACE]) ? (existing[NAMESPACE] as Bag) : {};
  const sticky = data.sticky === null ? undefined : (data.sticky ?? parseSticky(previous.sticky));
  const widget = data.widget === null ? undefined : (data.widget ?? parseWidget(previous.widget));
  const nodeState =
    data.nodeState === null ? undefined : (data.nodeState ?? parseNodeState(previous.nodeState));

  return {
    ...existing,
    [NAMESPACE]: {
      schemaVersion: SCHEMA_VERSION,
      ...(sticky ? { sticky } : {}),
      ...(widget ? { widget } : {}),
      ...(nodeState ? { nodeState } : {}),
    },
  };
};
