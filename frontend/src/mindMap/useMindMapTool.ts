/**
 * Arming the Mind Map tool, and putting a root node where somebody clicked.
 *
 * Mirrors `../sticky/useStickyNotes.ts` exactly: a `custom` active tool hands
 * pointer-down to this hook instead of Excalidraw's own shape creation, so
 * the node is ours to build while panning, zooming and selection stay
 * Excalidraw's.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { InteractionCapability, SceneCapability } from "../integrations/excalidraw/capabilities";
import type { ActiveTool } from "../integrations/excalidraw/types";
import { pressEnterToEditLabel } from "../integrations/excalidraw/domBridge";
import { createRootOps, mapIdOf } from "./mindMapScene";
import { newMindMapElementId, newMindMapId } from "./mindMapElements";

export const MIND_MAP_TOOL = "mindMap";
export const MIND_MAP_SHORTCUT = "m";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "onPointerDown" | "read" | "setActiveTool" | "subscribe">;
  scene: Pick<SceneCapability, "apply" | "summaryById">;
};

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
};

export function useMindMapTool({ containerRef, canEdit, interaction, scene }: Options) {
  const [armed, setArmed] = useState(false);

  const setTool = useCallback(
    (tool: ActiveTool): boolean => {
      const result = interaction.setActiveTool(tool);
      if (result.ok) return true;
      toast.error("Couldn't switch to the Mind Map tool. Please try again.");
      return false;
    },
    [interaction],
  );
  const armTool = useCallback(() => setTool({ type: "custom", customType: MIND_MAP_TOOL }), [setTool]);
  const dropTool = useCallback(() => setTool({ type: "selection" }), [setTool]);

  useEffect(() => {
    if (!armed) return;
    return interaction.subscribe(({ activeTool: tool }) => {
      if (tool?.type !== "custom" || tool.customType !== MIND_MAP_TOOL) setArmed(false);
    });
  }, [armed, interaction]);

  const arm = () => {
    if (!canEdit) return;
    if (armed) {
      setArmed(false);
      dropTool();
    } else if (armTool()) {
      setArmed(true);
    }
  };

  useEffect(() => {
    if (!armed || !canEdit) return;
    return interaction.onPointerDown((point, activeTool) => {
      if (activeTool?.type !== "custom" || activeTool.customType !== MIND_MAP_TOOL) return;

      // One click, one map: back to selection immediately, the same reason
      // the sticky tool does.
      setArmed(false);
      if (!dropTool()) return;

      const mapId = newMindMapId();
      const id = newMindMapElementId();
      const inserted = scene.apply(createRootOps(mapId, id, point.x, point.y));
      if (!inserted.ok) {
        toast.error("Couldn't create the mind map. Please try again.");
        return;
      }

      requestAnimationFrame(() => {
        void pressEnterToEditLabel(containerRef.current, () => {
          const state = interaction.read();
          return state.ok && state.value.editingTextContainerId === id;
        });
      });
    });
  }, [armed, canEdit, containerRef, dropTool, interaction, scene]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== MIND_MAP_SHORTCUT) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const state = interaction.read();
      if (!state.ok || state.value.editingTextElementId) return;

      event.preventDefault();
      if (armed) {
        setArmed(false);
        dropTool();
      } else if (armTool()) {
        setArmed(true);
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [armed, armTool, canEdit, containerRef, dropTool, interaction]);

  return { armed, arm };
}

/** Re-exported so callers that only need to check "is this a mind-map map" don't import mindMapScene directly. */
export { mapIdOf };
