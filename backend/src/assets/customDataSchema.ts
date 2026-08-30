/**
 * The shape ExcaliDash writes onto an Excalidraw element.
 *
 * This is a contract between the frontend and this server, not a frontend
 * detail: the server reads element records to decide which assets a board
 * references and which widgets may turn a page. Moving the shape without
 * moving this file leaves the widgets invisible to the server -- the board
 * renders, and every page command is refused as "not part of this board".
 *
 * The read path (`NAMESPACE`, `SCHEMA_VERSION`, `WidgetKind`, `WidgetRecord`,
 * `readWidgetRecord`) is `@excalidash/domain/customData`, not duplicated here
 * -- the same move NIL-624 made for document pagination, for the same
 * reason: a hand-kept second copy is how the pagination byte-count
 * regression (backend 1 page vs. frontend 3 for the same 50,000-character
 * input, NIL-624) happened in the first place. See
 * backend/src/assets/customDataWidget.contract.test.ts for the behavioral
 * proof that this server and frontend/src/integrations/excalidraw/
 * customData.ts still agree.
 *
 * `withWidgetRecord` stays local: it is this server's own single-purpose
 * writer (replace only `widget`, preserve everything else in the
 * namespace), not the frontend's `withExcalidashData`, which additionally
 * patches `sticky`/`orchestratorThread` -- two record kinds this server
 * never reads. Unifying the writers would mean building a server-side
 * concept of a patch across fields the server has no reader for.
 *
 * `mindMap`/`mindMapProjection` (`mapId`/`parentId`/`orderKey`) are gone
 * (NIL-593, Schnitt 2): the frontend's own relationship layer for the v1
 * mind-map tool's mode was torn down, and this server side never had a
 * second caller for the equivalent readers -- `readMindMapRecord`/
 * `readMindMapProjectionRecord` existed only for their own unit test,
 * found and removed as dead code once the frontend teardown's own "nothing
 * reads mapId/parentId as structure anymore" claim was checked against the
 * whole codebase, not just `git grep` on the removed name (a plain search
 * for those identifiers never crossed the frontend/backend boundary, since
 * this file duplicates the shape rather than importing it). An old
 * element's stored `mindMap`/`mindMapProjection` fields are simply never
 * read here anymore, the same as on the frontend side.
 *
 * `nodeState` is retired for the same reason (NIL-606). The server never
 * interprets it; spreading an existing namespace while updating a widget
 * only preserves stored JSON and does not restore any Pin/Collapse behavior.
 */

export {
  NAMESPACE,
  SCHEMA_VERSION,
  readWidgetRecord,
  type WidgetKind,
  type WidgetRecord,
} from "@excalidash/domain/customData";

import { NAMESPACE, SCHEMA_VERSION, type WidgetRecord } from "@excalidash/domain/customData";

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
