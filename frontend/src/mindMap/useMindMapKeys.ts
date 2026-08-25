/**
 * Tab for a child, Enter for a sibling.
 *
 * Only fires from a selected mind-map node, not from inside its label: Tab
 * belongs to Excalidraw's own text editor there (it indents), the same
 * reason `useStickyKeys.ts` waits for Escape before Tab.
 */
import { useEffect } from "react";
import { toast } from "sonner";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
} from "../integrations/excalidraw/capabilities";
import { pressEnterToEditLabel } from "../integrations/excalidraw/domBridge";
import { addNodeOps, readMindMapNodes } from "./mindMapScene";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "apply" | "summaries">;
  selection: Pick<SelectionCapability, "read">;
};

/** The single selected mind-map node, if that is what is selected and nothing is being typed into. */
function selectedMindMapNodeId({
  interaction,
  scene,
  selection,
}: Pick<Options, "interaction" | "scene" | "selection">): string | null {
  const state = interaction.read();
  if (!state.ok || state.value.editingTextElementId) return null;

  const selected = selection.read();
  if (!selected.ok || selected.value.selectedIds.length !== 1) return null;

  const summaries = scene.summaries();
  if (!summaries.ok) return null;
  const id = selected.value.selectedIds[0];
  return readMindMapNodes(summaries.value).some((node) => node.summary.id === id) ? id : null;
}

export function useMindMapKeys({ canEdit, containerRef, interaction, scene, selection }: Options) {
  useEffect(() => {
    if (!canEdit) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // `pressEnterToEditLabel` (domBridge.ts) opens a new node's label by
      // dispatching a synthetic, unmodified Enter -- indistinguishable from a
      // real one by `event.key` alone. `isTrusted` is the browser's own
      // trusted-vs-scripted flag and is false only for a dispatched event, so
      // it is the one signal this handler can use without also swallowing a
      // real Enter a person presses right after opening a label. Without this
      // guard, opening a label fires this handler, which adds a sibling,
      // which opens ITS label the same way, forever -- caught by a real
      // browser run (mind-map.spec.ts), not by the jsdom-based unit tests,
      // which never dispatch a real (untrusted-flagged) event at all.
      if (!event.isTrusted) return;

      const wantsChild = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      const wantsSibling =
        event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (!wantsChild && !wantsSibling) return;

      const anchorId = selectedMindMapNodeId({ interaction, scene, selection });
      if (!anchorId) return;

      event.preventDefault();
      event.stopPropagation();

      const summaries = scene.summaries();
      if (!summaries.ok) return;
      const result = addNodeOps(summaries.value, wantsChild ? "child" : "sibling", anchorId);
      if (!result) return;

      const applied = scene.apply(result.ops);
      if (!applied.ok) {
        toast.error("Couldn't add to the mind map. Please try again.");
        return;
      }

      const newNodeId = result.newNodeId;
      requestAnimationFrame(() => {
        void pressEnterToEditLabel(containerRef.current, () => {
          const state = interaction.read();
          return state.ok && state.value.editingTextContainerId === newNodeId;
        });
      });
    };

    const target = containerRef.current;
    if (!target) return;
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [canEdit, containerRef, interaction, scene, selection]);
}
