/**
 * The Scene/Frame Navigator (NIL-284): the list a presenter jumps through.
 *
 * A frame is read straight off `scene.summaries()` -- `type === "frame"` --
 * not tracked separately. Order is document order, the order frames were
 * created in, which is also the order a workshop template inserts its own
 * frames in. There is no rename here: NIL-325's scope is listing and jumping,
 * not editing a frame's name (that stays Excalidraw's own double-click).
 */
import { useEffect, useState } from "react";
import type { SceneCapability } from "../../integrations/excalidraw/capabilities";
import type { SceneBounds } from "../../integrations/excalidraw/types";

export type FrameSummary = {
  readonly id: string;
  readonly name: string;
  readonly bounds: SceneBounds;
};

const FRAME_TYPES = new Set(["frame", "magicframe"]);

export const listFrames = (scene: Pick<SceneCapability, "summaries">): readonly FrameSummary[] => {
  const summaries = scene.summaries();
  if (!summaries.ok) return [];
  const frames: FrameSummary[] = [];
  let unnamedCount = 0;
  for (const element of summaries.value) {
    if (element.isDeleted || !FRAME_TYPES.has(element.type)) continue;
    unnamedCount += 1;
    frames.push({
      id: element.id,
      name: element.name || `Frame ${unnamedCount}`,
      bounds: [element.x, element.y, element.x + element.width, element.y + element.height],
    });
  }
  return frames;
};

const sameFrames = (a: readonly FrameSummary[], b: readonly FrameSummary[]): boolean =>
  a.length === b.length &&
  a.every((frame, index) => {
    const other = b[index];
    return (
      frame.id === other.id &&
      frame.name === other.name &&
      frame.bounds[0] === other.bounds[0] &&
      frame.bounds[1] === other.bounds[1] &&
      frame.bounds[2] === other.bounds[2] &&
      frame.bounds[3] === other.bounds[3]
    );
  });

/**
 * Recomputes on every scene change -- cheap enough not to debounce; a board
 * has tens, not thousands, of frames.
 *
 * `scene.subscribe`'s own contract warns "fires on every editor change;
 * consumers throttle" (`capabilities.ts`'s `SceneCapability.subscribe`), and
 * that is not advisory here: `onChange` fires on every render of the
 * Excalidraw component itself, not only a genuine data change, and setting
 * new React state from inside it re-renders this hook's own ancestor,
 * which re-renders `<Excalidraw>` as a child, which fires `onChange` again --
 * an unthrottled listener turns that into an infinite loop (confirmed against
 * a real browser: "Maximum update depth exceeded", ~20ms after the handle
 * became ready). The fix is not a debounce timer, which only slows the
 * loop down; it is never calling `setFrames` with a value that is not
 * actually different, which stops the loop from having a next iteration at
 * all once the derived list has genuinely stabilised.
 *
 * `isReady` is required, not optional: the Excalidraw handle "arrives late"
 * (`integrations/excalidraw/index.ts`'s own file comment) -- subscribing
 * before it exists returns a no-op unsubscribe from `scene.subscribe`
 * (`getApi()` is still null) that is never replaced, so the frame list would
 * freeze at whatever existed at mount and silently miss every element
 * inserted afterwards. Every other subscription in this codebase
 * (`useEditorCollaboration`'s socket effect, `useLibraryImportFromUrl`) gates
 * on the same flag for the same reason; this hook follows that precedent
 * instead of introducing a second way to wait for the handle.
 */
export const useFrameNavigator = (
  scene: SceneCapability,
  isReady: boolean,
): readonly FrameSummary[] => {
  const [frames, setFrames] = useState<readonly FrameSummary[]>(() => listFrames(scene));

  useEffect(() => {
    if (!isReady) return;
    const applyIfChanged = () => {
      const next = listFrames(scene);
      setFrames((current) => (sameFrames(current, next) ? current : next));
    };
    applyIfChanged();
    return scene.subscribe(applyIfChanged);
  }, [scene, isReady]);
  return frames;
};
