/**
 * Interaction: what the editor is doing right now.
 *
 * The riskiest read in the whole inventory. `editingTextElement`, `newElement`
 * and `resizingElement` are editor internals with no product contract, and today
 * four product files read them directly. Isolated here so a rename upstream is
 * one adapter failure rather than four product bugs that each look like
 * something else.
 *
 * Ids rather than booleans: the collaboration merge has to leave an element
 * alone while its own user is dragging or resizing it, and for that it needs to
 * know WHICH element, not merely that something is in flight.
 */

import { reportFailure } from "./compatibility/diagnostics";
import type { InteractionCapability } from "./capabilities";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type {
  ActiveTool,
  ArrowStyle,
  ElementId,
  InteractionState,
  ScenePoint,
  Unsubscribe,
} from "./types";
import { packageVersion } from "./version";

export type InteractionApi = {
  getAppState: () => Record<string, unknown>;
  onChange: (listener: () => void) => Unsubscribe;
  setActiveTool: (tool: Record<string, unknown>) => void;
  onPointerDown?: (
    listener: (activeTool: unknown, pointerDownState: unknown) => void,
  ) => Unsubscribe;
};

const idOf = (value: unknown): ElementId | null => {
  if (typeof value === "string" && value.length > 0) return value as ElementId;
  if (value && typeof value === "object") {
    const { id } = value as { id?: unknown };
    if (typeof id === "string" && id.length > 0) return id as ElementId;
  }
  return null;
};

export const readActiveTool = (value: unknown): ActiveTool => {
  if (!value || typeof value !== "object") return { type: "selection" };
  const { type, customType } = value as { type?: unknown; customType?: unknown };
  if (type === "custom" && typeof customType === "string") {
    return { type: "custom", customType };
  }
  if (type === "selection") return { type: "selection" };
  return { type: "builtin", name: typeof type === "string" ? type : "selection" };
};

export const toEditorTool = (tool: ActiveTool): Record<string, unknown> => {
  switch (tool.type) {
    case "custom":
      return { type: "custom", customType: tool.customType };
    case "builtin":
      return { type: tool.name };
    case "selection":
      return { type: "selection" };
  }
};

export const readInteraction = (appState: Record<string, unknown>): InteractionState => {
  const editing = appState.editingTextElement;
  return {
    editingTextElementId: idOf(editing),
    editingTextContainerId:
      editing && typeof editing === "object"
        ? idOf((editing as { containerId?: unknown }).containerId)
        : null,
    creatingElementId: idOf(appState.newElement),
    resizingElementId: idOf(appState.resizingElement),
    activeTool: readActiveTool(appState.activeTool),
  };
};

const strokeStyleOf = (value: unknown): ArrowStyle["strokeStyle"] =>
  value === "dashed" || value === "dotted" ? value : "solid";

const arrowheadOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const roundnessOf = (value: unknown): ArrowStyle["roundness"] =>
  // AppState names the user choice ("round" or "sharp"); an element's
  // `roundness` field is the separate `{ type }` representation. Arrows use
  // Excalidraw's proportional radius for the former.
  value === "round" ? { type: 2 } : null;

/** Only the app-state defaults named by Excalidraw's public API cross this seam. */
export const readArrowStyle = (appState: Record<string, unknown>): ArrowStyle => ({
  strokeColor:
    typeof appState.currentItemStrokeColor === "string"
      ? appState.currentItemStrokeColor
      : "#1b1b1f",
  strokeWidth:
    typeof appState.currentItemStrokeWidth === "number" ? appState.currentItemStrokeWidth : 2,
  strokeStyle: strokeStyleOf(appState.currentItemStrokeStyle),
  roundness: roundnessOf(appState.currentItemRoundness),
  startArrowhead: arrowheadOf(appState.currentItemStartArrowhead),
  endArrowhead: arrowheadOf(appState.currentItemEndArrowhead),
  elbowed: appState.currentItemArrowType === "elbow",
});

const sameTool = (a: ActiveTool, b: ActiveTool): boolean =>
  a.type === b.type &&
  (a.type !== "custom" || b.type !== "custom" || a.customType === b.customType) &&
  (a.type !== "builtin" || b.type !== "builtin" || a.name === b.name);

export const createInteractionCapability = (
  getApi: () => InteractionApi | null,
): InteractionCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };
  const notReady = <T>(seam: string): CapabilityResult<T> =>
    report(fail("not-ready", seam, { detail: "the editor handle is not attached" }));

  const capability: InteractionCapability = {
    read() {
      const api = getApi();
      if (!api) return notReady("interaction.read");
      return ok(readInteraction(api.getAppState()));
    },

    readArrowStyle() {
      const api = getApi();
      if (!api) return notReady("interaction.readArrowStyle");
      return ok(readArrowStyle(api.getAppState()));
    },

    subscribe(listener) {
      const api = getApi();
      if (!api) return () => {};
      return api.onChange(() => listener(readInteraction(api.getAppState())));
    },

    setActiveTool(tool) {
      const api = getApi();
      if (!api) return notReady("interaction.setActiveTool");
      api.setActiveTool(toEditorTool(tool));
      return ok(undefined);
    },

    async setActiveToolSettled(tool, options) {
      const api = getApi();
      if (!api) return notReady("interaction.setActiveToolSettled");
      const applied = capability.setActiveTool(tool);
      if (!applied.ok) return applied;

      // The tool is set through React state. A pointer event that lands before
      // that commits is read as a selection drag instead, which is the bug this
      // exists to prevent -- and today the consumer polls the app state by hand.
      const deadline = options?.timeoutMs ?? 1000;
      const startedAt = performance.now();
      while (performance.now() - startedAt < deadline) {
        if (sameTool(readActiveTool(api.getAppState().activeTool), tool)) return ok(undefined);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return report(
        fail("editor-changed", "interaction.setActiveToolSettled", {
          detail: "the tool did not become active within the deadline",
        }),
      );
    },

    onPointerDown(listener) {
      const api = getApi();
      if (!api?.onPointerDown) return () => {};
      return api.onPointerDown((activeTool, pointerDownState) => {
        const origin = (pointerDownState as { origin?: unknown } | null)?.origin;
        const point =
          origin && typeof origin === "object" ? (origin as { x?: unknown; y?: unknown }) : null;
        if (!point || typeof point.x !== "number" || typeof point.y !== "number") return;
        listener({ x: point.x, y: point.y } satisfies ScenePoint, readActiveTool(activeTool));
      });
    },
  };

  return capability;
};
