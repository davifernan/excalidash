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
 *     mindMap?,
 *     mindMapProjection?
 *   }
 *
 * Authority stays on the server. Comments, permissions and authorship are
 * never stored here; at most a stable reference to them.
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
 * The authoritative relationship for one mind-map node.
 *
 * It deliberately lives on the child rather than on the visible arrow. This
 * keeps one semantic edge in one place when two clients add siblings at the
 * same time. The root carries the same record with `parentId: null`.
 */
export type MindMapRecord = {
  readonly mapId: string;
  readonly parentId: string | null;
  readonly orderKey: string;
};

/**
 * Marker for an ordinary bound arrow that projects a semantic relationship.
 * It is a rendering aid only; `MindMapRecord.parentId` remains authoritative.
 */
export type MindMapProjectionRecord = {
  readonly mapId: string;
  readonly childId: string;
};

export type ExcalidashData = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly sticky?: StickyRecord;
  readonly widget?: WidgetRecord;
  readonly mindMap?: MindMapRecord;
  readonly mindMapProjection?: MindMapProjectionRecord;
};

export type ExcalidashDataPatch = {
  readonly sticky?: StickyRecord | null;
  readonly widget?: WidgetRecord | null;
  readonly mindMap?: MindMapRecord | null;
  readonly mindMapProjection?: MindMapProjectionRecord | null;
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

const parseMindMap = (value: unknown): MindMapRecord | undefined => {
  if (!isBag(value)) return undefined;
  const mapId = str(value.mapId);
  const parentId = value.parentId === null ? null : str(value.parentId);
  const orderKey = str(value.orderKey);
  if (mapId === null || (parentId === null && value.parentId !== null) || orderKey === null) {
    return undefined;
  }
  return { mapId, parentId, orderKey };
};

const parseMindMapProjection = (value: unknown): MindMapProjectionRecord | undefined => {
  if (!isBag(value)) return undefined;
  const mapId = str(value.mapId);
  const childId = str(value.childId);
  if (mapId === null || childId === null) return undefined;
  return { mapId, childId };
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
  const mindMap = parseMindMap(own.mindMap);
  const mindMapProjection = parseMindMapProjection(own.mindMapProjection);
  if (!sticky && !widget && !mindMap && !mindMapProjection) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(sticky ? { sticky } : {}),
    ...(widget ? { widget } : {}),
    ...(mindMap ? { mindMap } : {}),
    ...(mindMapProjection ? { mindMapProjection } : {}),
  };
};

export const readSticky = (element: unknown): StickyRecord | null =>
  readExcalidashData(element)?.sticky ?? null;

export const readWidget = (element: unknown): WidgetRecord | null =>
  readExcalidashData(element)?.widget ?? null;

export const readMindMap = (element: unknown): MindMapRecord | null =>
  readExcalidashData(element)?.mindMap ?? null;

export const readMindMapProjection = (element: unknown): MindMapProjectionRecord | null =>
  readExcalidashData(element)?.mindMapProjection ?? null;

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
  const mindMap =
    data.mindMap === null
      ? undefined
      : (data.mindMap ??
        (Object.prototype.hasOwnProperty.call(previous, "mindMap") ? previous.mindMap : undefined));
  const mindMapProjection =
    data.mindMapProjection === null
      ? undefined
      : (data.mindMapProjection ??
        (Object.prototype.hasOwnProperty.call(previous, "mindMapProjection")
          ? previous.mindMapProjection
          : undefined));

  return {
    ...existing,
    [NAMESPACE]: {
      schemaVersion: SCHEMA_VERSION,
      ...(sticky ? { sticky } : {}),
      ...(widget ? { widget } : {}),
      ...(mindMap !== undefined ? { mindMap } : {}),
      ...(mindMapProjection !== undefined ? { mindMapProjection } : {}),
    },
  };
};
