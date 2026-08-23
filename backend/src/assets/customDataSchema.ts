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

const WIDGET_KINDS = new Set<string>(["pdf", "markdown", "text"]);

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the widget record off an element, or nothing.
 *
 * Every field is named and nothing is said about the ones that are not: an
 * element may legitimately carry another writer's data, and rejecting it for
 * that would blank a working widget.
 */
export function readWidgetRecord(element: unknown): WidgetRecord | null {
  if (!isBag(element)) return null;
  const customData = element.customData;
  if (!isBag(customData)) return null;
  const own = customData[NAMESPACE];
  if (!isBag(own) || own.schemaVersion !== SCHEMA_VERSION) return null;
  const widget = own.widget;
  if (!isBag(widget)) return null;
  const { kind, assetId } = widget;
  if (typeof kind !== "string" || !WIDGET_KINDS.has(kind)) return null;
  if (typeof assetId !== "string" || assetId.length === 0) return null;
  return { kind: kind as WidgetKind, assetId };
}
