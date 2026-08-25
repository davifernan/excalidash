import { withExcalidashData } from "../../integrations/excalidraw/customData";
import type { SceneCapability } from "../../integrations/excalidraw/capabilities";
import type { CapabilityResult } from "../../integrations/excalidraw/errors";
import type { ElementId } from "../../integrations/excalidraw/types";
import { getAssetWidgetData } from "./pdfWidgetElements";

export type DocumentAssetReplacement = Readonly<{
  drawingId: string;
  elementId: string;
  previousAssetId: string;
  assetId: string;
  drawingVersion: number;
  element: Record<string, unknown>;
}>;

export const applyDocumentAssetReplacement = (
  scene: SceneCapability,
  replacement: DocumentAssetReplacement,
  capture: "immediate" | "never",
): Promise<CapabilityResult<void>> => {
  const summary = scene.summaryById(replacement.elementId as ElementId);
  if (!summary.ok) return Promise.resolve(summary as CapabilityResult<void>);
  if (!summary.value) return Promise.resolve({ ok: true, value: undefined });
  const widget = getAssetWidgetData(summary.value);
  if (!widget || widget.widgetKind !== "markdown")
    return Promise.resolve({ ok: true, value: undefined });
  if (widget.assetId === replacement.assetId)
    return Promise.resolve({ ok: true, value: undefined });
  if (widget.assetId !== replacement.previousAssetId)
    return Promise.resolve({ ok: true, value: undefined });

  return scene.applySettled(
    [
      {
        kind: "patch",
        id: replacement.elementId as ElementId,
        changes: {
          customData: withExcalidashData(summary.value, {
            widget: { kind: "markdown", assetId: replacement.assetId },
          }),
        },
      },
    ],
    { capture },
  );
};
