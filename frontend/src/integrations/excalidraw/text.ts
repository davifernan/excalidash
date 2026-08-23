/** Bound text reads and writes for container-backed labels. */

import { reportFailure } from "./compatibility/diagnostics";
import type { TextContainerCapability } from "./capabilities";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { BoundLabel, ElementId } from "./types";
import { packageVersion } from "./version";

export type TextContainerApi = {
  getSceneElementsIncludingDeleted: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
};

const asElement = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

export const createTextContainerCapability = (
  getApi: () => TextContainerApi | null,
): TextContainerCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };
  const notReady = <T>(seam: string): CapabilityResult<T> =>
    report(fail("not-ready", seam, { detail: "the editor handle is not attached" }));

  const readLabel = (
    containerId: ElementId,
    seam = "text.readLabel",
  ): CapabilityResult<BoundLabel | null> => {
    const api = getApi();
    if (!api) return notReady(seam);

    const elements = api.getSceneElementsIncludingDeleted();
    const container = elements
      .map(asElement)
      .find((element) => element?.id === containerId && element.isDeleted !== true);
    if (!container) return ok(null);

    const bindings = container.boundElements;
    if (bindings === null || bindings === undefined) return ok(null);
    if (!Array.isArray(bindings)) {
      return report(
        fail("editor-changed", seam, {
          detail: "container boundElements is no longer an array",
        }),
      );
    }

    const textBinding = bindings.map(asElement).find((binding) => binding?.type === "text");
    if (!textBinding) return ok(null);
    if (typeof textBinding.id !== "string" || textBinding.id.length === 0) {
      return report(
        fail("editor-changed", seam, {
          detail: "a text binding has no element id",
        }),
      );
    }

    const label = elements
      .map(asElement)
      .find((element) => element?.id === textBinding.id && element?.isDeleted !== true);
    if (!label) return ok(null);
    if (
      label.type !== "text" ||
      label.containerId !== containerId ||
      typeof label.text !== "string" ||
      typeof label.originalText !== "string" ||
      typeof label.fontSize !== "number" ||
      !Number.isFinite(label.fontSize)
    ) {
      return report(
        fail("editor-changed", seam, {
          detail: "the bound text element no longer has the expected fields",
        }),
      );
    }

    return ok({
      id: textBinding.id as ElementId,
      containerId,
      text: label.text,
      originalText: label.originalText,
      fontSize: label.fontSize,
    });
  };

  return {
    readLabel,

    labelsBeingTyped() {
      const api = getApi();
      if (!api) return notReady("text.labelsBeingTyped");
      const editing = api.getAppState().editingTextElement;
      if (editing === null || editing === undefined) return ok([]);
      if (typeof editing !== "object") {
        return report(
          fail("editor-changed", "text.labelsBeingTyped", {
            detail: "editingTextElement is no longer an element or null",
          }),
        );
      }
      const containerId = (editing as { containerId?: unknown }).containerId;
      if (containerId === null || containerId === undefined) return ok([]);
      if (typeof containerId !== "string" || containerId.length === 0) {
        return report(
          fail("editor-changed", "text.labelsBeingTyped", {
            detail: "the edited text has an invalid container id",
          }),
        );
      }
      return ok([containerId as ElementId]);
    },

    setLabelFontSize(containerId, fontSize) {
      if (!Number.isFinite(fontSize) || fontSize <= 0) {
        return report(
          fail("invalid-state", "text.setLabelFontSize", {
            detail: "font size must be a positive finite number",
          }),
        );
      }
      const label = readLabel(containerId, "text.setLabelFontSize");
      if (!label.ok) return label;
      if (!label.value) {
        return report(
          fail("invalid-state", "text.setLabelFontSize", {
            detail: "the container has no bound text element",
          }),
        );
      }
      return ok({ kind: "patch", id: label.value.id, changes: { fontSize } });
    },
  };
};
