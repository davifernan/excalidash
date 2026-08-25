/**
 * The sticky note feature, as one thing the editor can switch on.
 *
 * The editor page is already long and its job is wiring, not notes. It gets one
 * node to render inside the canvas container and one change handler, and needs
 * to know nothing else about how a note is put together.
 */
import React, { useCallback, useRef, useState } from "react";
import type {
  InteractionCapability,
  SceneCapability,
  SelectionCapability,
  ViewportCapability,
} from "../integrations/excalidraw/capabilities";
import { StickyHandles } from "./StickyHandles";
import { StickyPalette } from "./StickyPalette";
import { StickyPreview } from "./StickyPreview";
import { StickyToolbarButton } from "./StickyToolbarButton";
import { useStickyHint } from "./useStickyHint";
import { useStickyKeys } from "./useStickyKeys";
import { useStickyNotes } from "./useStickyNotes";
import { useStickyUpkeep } from "./useStickyUpkeep";

type Options = {
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
  elements: () => readonly any[];
  interaction: InteractionCapability;
  isDragging: () => boolean;
  scene: SceneCapability;
  selection: SelectionCapability;
  viewport: ViewportCapability;
  /** The editor's own change handler, which still has to run. */
  onCanvasChange: (elements: readonly any[], appState: any, files?: Record<string, any>) => void;
};

export function useStickyNotesFeature({
  containerRef,
  canEdit,
  elements,
  interaction,
  isDragging,
  onCanvasChange,
  scene,
  selection,
  viewport,
}: Options) {
  // The editor hands its API over after the first render, so anything that
  // needs to subscribe has to wait for a sign of life. The first change event
  // is that sign.
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  const { armed, color, arm, setColor } = useStickyNotes({
    containerRef,
    canEdit,
    elements,
    interaction,
    scene,
  });

  useStickyKeys({ containerRef, canEdit, elements, interaction, scene, selection });
  useStickyHint({ containerRef, canEdit, interaction, ready, scene, selection });
  const { onSceneChange } = useStickyUpkeep({ canEdit, interaction, scene });

  const handleCanvasChange = useCallback(
    (elements: readonly any[], appState: any, files?: Record<string, any>) => {
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
      onSceneChange(elements, appState);
      onCanvasChange(elements, appState, files);
    },
    [onCanvasChange, onSceneChange],
  );

  const stickyOverlay = canEdit ? (
    <>
      <StickyToolbarButton containerRef={containerRef} armed={armed} color={color} onArm={arm} />
      <StickyPalette
        containerRef={containerRef}
        scene={scene}
        selection={selection}
        viewport={viewport}
        interaction={interaction}
        ready={ready}
        onPick={setColor}
      />
      {armed && <StickyPreview containerRef={containerRef} color={color} viewport={viewport} />}
      <StickyHandles
        containerRef={containerRef}
        canEdit={canEdit}
        interaction={interaction}
        isDragging={isDragging}
        scene={scene}
        selection={selection}
        viewport={viewport}
      />
    </>
  ) : null;

  return { stickyOverlay, onCanvasChange: handleCanvasChange };
}
