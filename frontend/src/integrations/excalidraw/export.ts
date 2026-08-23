/**
 * Export: the board as a picture, with the parts that only exist in React
 * replaced by something a picture can show.
 *
 * NIL-277: an embeddable exports as an empty box carrying its URL, because the
 * export renders the scene rather than the component tree a widget lives in.
 * That affects three outputs at once -- the file export, the dashboard
 * thumbnail, and the PNG the MCP server produces -- because all three go
 * through the same scene.
 */

import { exportToSvg } from "@excalidraw/excalidraw";

import { reportFailure } from "./compatibility/diagnostics";
import type { ExportCapability, ExportOptions, WidgetDescriptor } from "./capabilities";
import { readWidget } from "./customData";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { ElementSummary, SceneDocument } from "./types";
import { packageVersion } from "./version";
import { WIDGET_LINK, exportSubstitute } from "./widgets";

/** Reads the same way the widget capability does, on a raw element. */
const describeWidget = (element: Record<string, unknown>): WidgetDescriptor | null => {
  if (element.type !== "embeddable" || element.link !== WIDGET_LINK) return null;
  const widget = readWidget(element);
  return widget ? { kind: widget.kind, schemaVersion: 2, assetId: widget.assetId } : null;
};

const asSummary = (element: Record<string, unknown>): ElementSummary =>
  ({
    id: String(element.id),
    x: typeof element.x === "number" ? element.x : 0,
    y: typeof element.y === "number" ? element.y : 0,
    width: typeof element.width === "number" ? element.width : 0,
    height: typeof element.height === "number" ? element.height : 0,
    angle: typeof element.angle === "number" ? element.angle : 0,
  }) as unknown as ElementSummary;

/**
 * Swap every widget for something the renderer can draw.
 *
 * A pure function over the element list so it can be tested without an editor,
 * and so the live scene is never touched: the export works on a clone, and a
 * substitution that reached the board would replace the reader's real widget
 * with a picture of one.
 */
export const substituteWidgets = (
  elements: readonly Record<string, unknown>[],
): { elements: Record<string, unknown>[]; substituted: number } => {
  let substituted = 0;
  const out = elements.map((element) => {
    const descriptor = describeWidget(element);
    if (!descriptor) return element;
    substituted += 1;
    return exportSubstitute(asSummary(element), descriptor);
  });
  return { elements: out, substituted };
};

export type ExportDocumentReader = (document: SceneDocument) => {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
} | null;

export const createExportCapability = (
  readDocument: ExportDocumentReader,
  sealDocument: (value: {
    elements: readonly Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  }) => SceneDocument,
): ExportCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };

  return {
    exportableDocument(document) {
      const opened = readDocument(document);
      if (!opened) {
        return report(
          fail("invalid-state", "export.exportableDocument", {
            detail: "not a document produced by this adapter",
          }),
        );
      }
      const { elements } = substituteWidgets(opened.elements);
      return ok(sealDocument({ ...opened, elements }));
    },

    async toSvg(options: ExportOptions) {
      const opened = readDocument(options.document);
      if (!opened) {
        return report(
          fail("invalid-state", "export.toSvg", {
            detail: "not a document produced by this adapter",
          }),
        );
      }
      const { elements } = substituteWidgets(opened.elements);
      try {
        const svg = await exportToSvg({
          elements: elements as never,
          appState: {
            ...opened.appState,
            exportBackground: options.withBackground ?? true,
            exportEmbedScene: options.includeMetadata ?? false,
          } as never,
          files: opened.files as never,
          exportPadding: options.padding ?? 10,
        });
        return ok(svg as SVGSVGElement);
      } catch (error) {
        return report(
          fail("editor-changed", "export.toSvg", {
            detail: error instanceof Error ? error.name : "exportToSvg threw",
          }),
        );
      }
    },
  };
};
