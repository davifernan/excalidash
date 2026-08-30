/**
 * The document-widget slice of the `customData.excalidash` namespace --
 * shared because the server reads it to decide which assets a board
 * references and which widgets may turn a page (NIL-637, second contract
 * pulled out of #203/NIL-625, same mechanism as document pagination).
 *
 * Sticky notes and the Orchestrator Thread anchor also live in this
 * namespace, but only on the frontend: the server has no reader for either,
 * so they stay out of this shared module rather than being duplicated for
 * an importer that does not exist.
 */

export const NAMESPACE = "excalidash";
export const SCHEMA_VERSION = 2;

export type WidgetKind = "pdf" | "markdown" | "text";

export type WidgetRecord = {
  readonly kind: WidgetKind;
  readonly assetId: string;
};

export const WIDGET_KINDS: readonly WidgetKind[] = ["pdf", "markdown", "text"];

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The namespace bag for `customData.excalidash`, gated on the schema
 * version both sides agree on -- or nothing. Shared because a version
 * bump on one side without the other must make every reader on the older
 * side see "no data" rather than misread a shape it does not expect.
 */
export const readNamespaceBag = (element: unknown): Bag | null => {
  if (!isBag(element)) return null;
  const customData = element.customData;
  if (!isBag(customData)) return null;
  const own = customData[NAMESPACE];
  return isBag(own) && own.schemaVersion === SCHEMA_VERSION ? own : null;
};

/**
 * Validate a `widget` value off the namespace bag, or nothing.
 *
 * The rule that must stay identical on both sides: `kind` must be one of
 * the three known widget kinds, and `assetId` must be a non-empty string.
 * Anything else -- an unknown kind, a missing/empty assetId, a foreign
 * shape -- is treated as "no widget", never as an error, since an element
 * may legitimately carry another writer's data.
 */
export const parseWidgetRecord = (value: unknown): WidgetRecord | undefined => {
  if (!isBag(value)) return undefined;
  const kind = WIDGET_KINDS.find((candidate) => candidate === value.kind);
  const assetId = value.assetId;
  if (!kind || typeof assetId !== "string" || assetId.length === 0) return undefined;
  return { kind, assetId };
};

/** Read the widget record off an element, or nothing. */
export const readWidgetRecord = (element: unknown): WidgetRecord | null =>
  parseWidgetRecord(readNamespaceBag(element)?.widget) ?? null;
