/**
 * The Mind Map feature, as one thing the editor can switch on.
 *
 * Mirrors `../sticky/index.tsx`: the editor page gets one overlay node, one
 * change handler, and one callback for the "Arrange mind map" command it
 * threads into `chromeSlots.tsx` -- and needs to know nothing else about how
 * a map is put together.
 */
import React, { useCallback } from "react";
import { toast } from "sonner";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import { Minus } from "lucide-react";
import { ElementFloatingToolbar } from "../pages/editor/ElementFloatingToolbar";
import { useExcalidrawRoot } from "../pages/editor/useExcalidrawRoot";
import { MindMapCollapseOverlay } from "./MindMapCollapseOverlay";
import { MindMapDropHighlight } from "./MindMapDropHighlight";
import { MindMapToolbarButton } from "./MindMapToolbarButton";
import { useMindMapTool } from "./useMindMapTool";
import { useMindMapKeys } from "./useMindMapKeys";
import { useMindMapDrag } from "./useMindMapDrag";
import { useMindMapCollapse } from "./useMindMapCollapse";
import { useMindMapIntegrity } from "./useMindMapIntegrity";
import { arrangeOps, mapIdOf, readMindMapNodes } from "./mindMapScene";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  interaction: InteractionCapability;
  scene: SceneCapability;
  selection: SelectionCapability;
  viewport: ViewportCapability;
  /** The editor's own change handler, which still has to run. */
  onCanvasChange: (elements: readonly any[], appState: any, files?: Record<string, any>) => void;
};

export function useMindMapFeature({
  containerRef,
  canEdit,
  interaction,
  onCanvasChange,
  scene,
  selection,
  viewport,
}: Options) {
  const excalidrawRoot = useExcalidrawRoot(containerRef);
  const { armed, arm } = useMindMapTool({ containerRef, canEdit, interaction, scene });
  useMindMapKeys({ containerRef, canEdit, interaction, scene, selection });
  const { onSceneChange: onDragSceneChange, preview } = useMindMapDrag({
    canEdit,
    scene,
    selection,
  });
  const { onSceneChange: onIntegritySceneChange } = useMindMapIntegrity({ canEdit, scene });
  const {
    onSceneChange: onCollapseSceneChange,
    toolbarTarget: collapseToolbarTarget,
    toggleCollapse,
  } = useMindMapCollapse({ canEdit, excalidrawRoot, interaction, scene, selection, viewport });

  const handleCanvasChange = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      // Drag detection first: it only reads the scene, and its own
      // follow-up `scene.apply` (if any) should land before the integrity
      // pass looks at the board, not after.
      onDragSceneChange();
      onIntegritySceneChange(elements);
      onCollapseSceneChange();
      onCanvasChange(elements, appState, files);
    },
    [onCanvasChange, onCollapseSceneChange, onDragSceneChange, onIntegritySceneChange],
  );

  /**
   * The map to arrange: the one carrying the current selection, or -- with
   * nothing selected -- the board's only map, so the command still does
   * something useful on a single-map board without asking anyone to click
   * a node first. More than one map with nothing selected has no single
   * right answer, so it asks rather than guessing.
   */
  const onArrangeMindMap = useCallback(() => {
    if (!canEdit) return;
    const summaries = scene.summaries();
    if (!summaries.ok) return;

    const selected = selection.read();
    const selectedMapId =
      selected.ok && selected.value.selectedIds.length === 1
        ? mapIdOf(summaries.value.find((element) => element.id === selected.value.selectedIds[0]))
        : null;

    let mapId = selectedMapId;
    if (!mapId) {
      const mapIds = new Set(readMindMapNodes(summaries.value).map((node) => node.relation.mapId));
      if (mapIds.size === 0) {
        toast.error("There's no mind map on this board yet.");
        return;
      }
      if (mapIds.size > 1) {
        toast.error("Select a node in the mind map you want to arrange.");
        return;
      }
      mapId = [...mapIds][0];
    }

    const ops = arrangeOps(summaries.value, mapId);
    if (!ops) {
      toast.error(
        "This mind map has an issue (a cycle or a missing node) and can't be arranged yet.",
      );
      return;
    }
    if (ops.length === 0) return;
    const applied = scene.apply(ops);
    if (!applied.ok) toast.error("Couldn't arrange the mind map. Please try again.");
  }, [canEdit, scene, selection]);

  const mindMapOverlay = canEdit ? (
    <>
      <MindMapToolbarButton containerRef={containerRef} armed={armed} onArm={arm} />
      <MindMapDropHighlight
        container={excalidrawRoot}
        preview={preview}
        scene={scene}
        viewport={viewport}
      />
      <MindMapCollapseOverlay
        container={excalidrawRoot}
        scene={scene}
        viewport={viewport}
        onExpand={toggleCollapse}
      />
      <ElementFloatingToolbar target={collapseToolbarTarget} label="Mind map node actions">
        <button
          type="button"
          data-testid="mind-map-collapse-button"
          // Without this, clicking the button moves DOM focus off the
          // canvas, and the very next Ctrl+Z silently fails to undo the
          // collapse -- caught by a real browser run (`mind-map-collapse.spec.ts`),
          // not by any unit test, since jsdom never models focus-dependent
          // history capture. `preventDefault` on `mousedown` (not
          // `stopPropagation`, which the parent toolbar already does for a
          // different reason) keeps focus wherever it already was.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const selected = selection.read();
            if (selected.ok && selected.value.selectedIds.length === 1) {
              toggleCollapse(selected.value.selectedIds[0]);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            border: "none",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            cursor: "pointer",
          }}
        >
          <Minus size={16} />
          Collapse
        </button>
      </ElementFloatingToolbar>
    </>
  ) : null;

  return { mindMapOverlay, onArrangeMindMap, onCanvasChange: handleCanvasChange };
}
