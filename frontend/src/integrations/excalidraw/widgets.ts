/**
 * Widgets: ExcaliDash documents living on an Excalidraw board.
 *
 * A widget is an ordinary embeddable element carrying our own record in
 * customData. Identification goes through the schema helper, so there is one
 * answer to "is this ours" rather than one per consumer.
 */

import { reportFailure } from "./compatibility/diagnostics";
import type { WidgetCapability, WidgetDescriptor } from "./capabilities";
import { readWidget, withExcalidashData } from "./customData";
import { buildElements } from "./elements";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { ElementId, ElementSummary, NewElement, SceneOp, ScenePoint } from "./types";
import { packageVersion } from "./version";

export const WIDGET_LINK = "excalidash://asset-widget";

/** Sizes the editor gives a new widget. Kept here, not at the call site. */
const SIZES: Record<WidgetDescriptor["kind"], { width: number; height: number }> = {
  pdf: { width: 480, height: 680 },
  markdown: { width: 520, height: 560 },
  text: { width: 520, height: 560 },
};

export type WidgetApi = {
  getAppState: () => Record<string, unknown>;
  /** Whether this viewer may edit at all, as the host was told. */
  canEdit: () => boolean;
};

/**
 * A replacement element for export.
 *
 * NIL-277: an embeddable exports as an empty box with its URL, because the
 * export renders the scene rather than the React tree the widget lives in. The
 * substitute is a plain rectangle carrying a readable label, which is the same
 * shape the reader would have seen, minus the interactivity that a static image
 * could not have had anyway.
 *
 * Built through the skeleton API rather than written as a literal, and that is
 * the whole point of this function existing: `label` is not a property of an
 * Excalidraw element. Only convertToExcalidrawElements understands it, and it
 * turns it into a real bound text element. Handing a literal with a `label` key
 * straight to exportToSvg produces a grey box with no text at all -- the very
 * defect this is meant to fix, one layer further in.
 *
 * Returns the container and its bound text, so callers splice both in.
 */
export const exportSubstitute = (
  element: ElementSummary,
  descriptor: WidgetDescriptor,
): Record<string, unknown>[] =>
  buildElements(
    [
      {
        id: `${element.id}-export`,
        type: "rectangle",
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        angle: element.angle,
        strokeColor: "#1e1e1e",
        backgroundColor: "#f5f5f5",
        fillStyle: "solid",
        roughness: 0,
        label: {
          text: `${descriptor.kind.toUpperCase()} document`,
          fontSize: 20,
          textAlign: "center",
          verticalAlign: "middle",
        },
      },
    ],
    { regenerateIds: false },
  );

export const createWidgetCapability = (getApi: () => WidgetApi | null): WidgetCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };

  return {
    identify(element) {
      if (element.type !== "embeddable" || element.link !== WIDGET_LINK) return ok(null);
      const widget = readWidget({ customData: element.customData });
      if (!widget) return ok(null);
      return ok({ kind: widget.kind, schemaVersion: 2, assetId: widget.assetId });
    },

    describe(descriptor, at: ScenePoint) {
      const size = SIZES[descriptor.kind];
      if (!size) {
        return report(fail("invalid-state", "widgets.describe", { detail: "unknown widget kind" }));
      }
      const element: NewElement = {
        id: crypto.randomUUID() as ElementId,
        type: "embeddable",
        x: at.x - size.width / 2,
        y: at.y - size.height / 2,
        width: size.width,
        height: size.height,
        link: WIDGET_LINK,
        customData: withExcalidashData(
          {},
          { widget: { kind: descriptor.kind, assetId: descriptor.assetId } },
        ),
      };
      return ok({ kind: "insert", elements: [element] } satisfies SceneOp);
    },

    /**
     * NIL-311, and the answer is narrower than it first looked.
     *
     * With a mouse the premise holds: an embeddable activates on double click,
     * that path is guarded by `!viewModeEnabled`, and the host sets
     * `viewModeEnabled={!canEdit}`. A read-only visitor never reaches the
     * widget's own controls.
     *
     * With touch it does not. Excalidraw also activates an embeddable from a
     * short tap on its centre (`handleEmbeddableCenterClick`, reached from
     * `handleCanvasPointerUp` via `isIframeLikeElementCenter`), and that path
     * carries no view-mode check at all -- verified against 0.18.1. So a
     * read-only visitor on a tablet CAN make the widget interactive.
     *
     * This still reports "read-only" for such a viewer, and that is the point:
     * it describes what the application permits, not what the editor happens to
     * allow. A widget rendering a static view honours the permission even where
     * the editor would not enforce it. What it must not do is claim the editor
     * makes that impossible -- it does not, and a control that appears only on
     * touch is exactly the kind of thing nobody tests.
     */
    interactionMode() {
      const api = getApi();
      if (!api) {
        return report(
          fail("not-ready", "widgets.interactionMode", {
            detail: "the editor handle is not attached",
            fallback: "static-widget",
          }),
        );
      }
      return ok(api.canEdit() ? "interactive" : "read-only");
    },
  };
};
