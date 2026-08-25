/**
 * The shape ExcaliDash writes onto an Excalidraw element.
 *
 * This is a contract between the frontend and this server, not a frontend
 * detail: the server reads element records to decide which assets a board
 * references and which widgets may turn a page. Moving the shape without
 * moving this file leaves the widgets invisible to the server -- the board
 * renders, and every page command is refused as "not part of this board".
 *
 * Kept in step with frontend/src/integrations/excalidraw/customData.ts.
 */

export const NAMESPACE = "excalidash";
export const SCHEMA_VERSION = 2;

export type WidgetKind = "pdf" | "markdown" | "text";

export type WidgetRecord = {
  kind: WidgetKind;
  assetId: string;
};

export type MindMapRecord = {
  mapId: string;
  parentId: string | null;
  orderKey: string;
};

export type MindMapProjectionRecord = {
  mapId: string;
  childId: string;
};

const WIDGET_KINDS = new Set<string>(["pdf", "markdown", "text"]);

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readNamespace = (element: unknown): Record<string, unknown> | null => {
  if (!isBag(element)) return null;
  const customData = element.customData;
  if (!isBag(customData)) return null;
  const own = customData[NAMESPACE];
  return isBag(own) && own.schemaVersion === SCHEMA_VERSION ? own : null;
};

/**
 * Read the widget record off an element, or nothing.
 *
 * Every field is named and nothing is said about the ones that are not: an
 * element may legitimately carry another writer's data, and rejecting it for
 * that would blank a working widget.
 */
export function readWidgetRecord(element: unknown): WidgetRecord | null {
  const own = readNamespace(element);
  if (!own) return null;
  const widget = own.widget;
  if (!isBag(widget)) return null;
  const { kind, assetId } = widget;
  if (typeof kind !== "string" || !WIDGET_KINDS.has(kind)) return null;
  if (typeof assetId !== "string" || assetId.length === 0) return null;
  return { kind: kind as WidgetKind, assetId };
}

/** Replace only this application's widget reference, preserving foreign data. */
export function withWidgetRecord(element: unknown, widget: WidgetRecord): Record<string, unknown> {
  if (!isBag(element)) throw new Error("Document widget element is not an object");
  const customData = isBag(element.customData) ? element.customData : {};
  const own = isBag(customData[NAMESPACE]) ? customData[NAMESPACE] : {};
  return {
    ...element,
    customData: {
      ...customData,
      [NAMESPACE]: {
        ...own,
        schemaVersion: SCHEMA_VERSION,
        widget,
      },
    },
  };
}

/**
 * Server-side validation for the same semantic node record the adapter writes.
 * The server does not infer relationships from arrows and does not repair an
 * invalid tree while saving or restoring a drawing.
 */
export function readMindMapRecord(element: unknown): MindMapRecord | null {
  const own = readNamespace(element);
  if (!own || !isBag(own.mindMap)) return null;
  const { mapId, parentId, orderKey } = own.mindMap;
  if (typeof mapId !== "string" || mapId.length === 0) return null;
  if (parentId !== null && (typeof parentId !== "string" || parentId.length === 0)) return null;
  if (typeof orderKey !== "string" || orderKey.length === 0) return null;
  return { mapId, parentId, orderKey };
}

export function readMindMapProjectionRecord(element: unknown): MindMapProjectionRecord | null {
  const own = readNamespace(element);
  if (!own || !isBag(own.mindMapProjection)) return null;
  const { mapId, childId } = own.mindMapProjection;
  if (typeof mapId !== "string" || mapId.length === 0) return null;
  if (typeof childId !== "string" || childId.length === 0) return null;
  return { mapId, childId };
}
