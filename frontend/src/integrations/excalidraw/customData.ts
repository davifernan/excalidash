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
 *     orchestratorThread?
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
 * NIL-606 also removed Pin and Collapse. Their `nodeState` field follows the
 * same retirement rule: old JSON is tolerated as unknown Excalidraw data,
 * but it is not parsed, surfaced, or preserved by this application's writer.
 * Existing boards therefore load without the retired state silently
 * affecting Arrange or rendering hidden content.
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
};

export type WidgetKind = "pdf" | "markdown" | "text";

export type WidgetRecord = {
  readonly kind: WidgetKind;
  readonly assetId: string;
};

/**
 * Stable identity for a shared Orchestrator Thread Board Card (NIL-678).
 * This is deliberately only a reference and display label. Audience,
 * Context, Dispatch and Lease authority stay outside the drawing payload;
 * visual proximity must never be able to manufacture any of them (V3).
 */
export type OrchestratorThreadAnchorRecord = {
  readonly threadId: string;
  readonly title: string;
};

export type ExcalidashData = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sticky?: StickyRecord;
  readonly widget?: WidgetRecord;
  readonly orchestratorThread?: OrchestratorThreadAnchorRecord;
};

export type ExcalidashDataPatch = {
  readonly sticky?: StickyRecord | null;
  readonly widget?: WidgetRecord | null;
  readonly orchestratorThread?: OrchestratorThreadAnchorRecord | null;
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
  if (color === null || ink === null || width === null || height === null) {
    return undefined;
  }
  return { color, ink, width, height };
};

const parseWidget = (value: unknown): WidgetRecord | undefined => {
  if (!isBag(value)) return undefined;
  const kind = WIDGET_KINDS.find((candidate) => candidate === value.kind);
  const assetId = str(value.assetId);
  if (!kind || assetId === null) return undefined;
  return { kind, assetId };
};

const parseOrchestratorThread = (value: unknown): OrchestratorThreadAnchorRecord | undefined => {
  if (!isBag(value)) return undefined;
  const threadId = str(value.threadId);
  const title = str(value.title);
  if (threadId === null || title === null || title.length > 200) return undefined;
  return { threadId, title };
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
  const orchestratorThread = parseOrchestratorThread(own.orchestratorThread);
  if (!sticky && !widget && !orchestratorThread) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(sticky ? { sticky } : {}),
    ...(widget ? { widget } : {}),
    ...(orchestratorThread ? { orchestratorThread } : {}),
  };
};

export const readSticky = (element: unknown): StickyRecord | null =>
  readExcalidashData(element)?.sticky ?? null;

export const readWidget = (element: unknown): WidgetRecord | null =>
  readExcalidashData(element)?.widget ?? null;

export const readOrchestratorThreadAnchor = (
  element: unknown,
): OrchestratorThreadAnchorRecord | null => readExcalidashData(element)?.orchestratorThread ?? null;

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
  const orchestratorThread =
    data.orchestratorThread === null
      ? undefined
      : (data.orchestratorThread ?? parseOrchestratorThread(previous.orchestratorThread));

  return {
    ...existing,
    [NAMESPACE]: {
      schemaVersion: SCHEMA_VERSION,
      ...(sticky ? { sticky } : {}),
      ...(widget ? { widget } : {}),
      ...(orchestratorThread ? { orchestratorThread } : {}),
    },
  };
};
