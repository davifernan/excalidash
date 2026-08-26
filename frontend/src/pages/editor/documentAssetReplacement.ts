import { withExcalidashData } from "../../integrations/excalidraw/customData";
import type { DocumentAssetReplacement } from "@excalidash/domain/collaboration";
import type { SceneCapability } from "../../integrations/excalidraw/capabilities";
import type { CapabilityResult } from "../../integrations/excalidraw/errors";
import type { ElementId } from "../../integrations/excalidraw/types";
import { getAssetWidgetData } from "./pdfWidgetElements";

export type { DocumentAssetReplacement } from "@excalidash/domain/collaboration";

export const applyDocumentAssetReplacement = (
  scene: SceneCapability,
  replacement: DocumentAssetReplacement,
  capture: "immediate" | "never",
): Promise<CapabilityResult<void>> => {
  const patches = [];
  for (const replacementElement of replacement.elements) {
    const elementId = replacementElement?.id;
    if (typeof elementId !== "string" || !elementId) continue;
    const summary = scene.summaryById(elementId as ElementId);
    if (!summary.ok) return Promise.resolve(summary as CapabilityResult<void>);
    if (!summary.value) continue;
    const widget = getAssetWidgetData(summary.value);
    if (!widget || widget.widgetKind !== "markdown") continue;
    if (widget.assetId === replacement.assetId) continue;
    if (widget.assetId !== replacement.previousAssetId) continue;
    patches.push({
      kind: "patch" as const,
      id: elementId as ElementId,
      changes: {
        customData: withExcalidashData(summary.value, {
          widget: { kind: "markdown" as const, assetId: replacement.assetId },
        }),
      },
    });
  }

  if (patches.length === 0) return Promise.resolve({ ok: true, value: undefined });

  return scene.applySettled(patches, { capture });
};
