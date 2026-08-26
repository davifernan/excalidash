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
 *     widget?
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

import {
  EXCALIDASH_NAMESPACE as NAMESPACE,
  EXCALIDASH_SCHEMA_VERSION as SCHEMA_VERSION,
  stickyRecordSchema,
  widgetRecordSchema,
  type ExcalidashData,
  type ExcalidashDataPatch,
  type StickyRecord,
  type WidgetKind,
  type WidgetRecord,
} from "@excalidash/domain/excalidraw";

export {
  NAMESPACE,
  SCHEMA_VERSION,
  type ExcalidashData,
  type ExcalidashDataPatch,
  type StickyRecord,
  type WidgetKind,
  type WidgetRecord,
};

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSticky = (value: unknown): StickyRecord | undefined => {
  const parsed = stickyRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const parseWidget = (value: unknown): WidgetRecord | undefined => {
  const parsed = widgetRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  if (!sticky && !widget) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(sticky ? { sticky } : {}),
    ...(widget ? { widget } : {}),
  };
};

export const readSticky = (element: unknown): StickyRecord | null =>
  readExcalidashData(element)?.sticky ?? null;

export const readWidget = (element: unknown): WidgetRecord | null =>
  readExcalidashData(element)?.widget ?? null;

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

  return {
    ...existing,
    [NAMESPACE]: {
      schemaVersion: SCHEMA_VERSION,
      ...(sticky ? { sticky } : {}),
      ...(widget ? { widget } : {}),
    },
  };
};
