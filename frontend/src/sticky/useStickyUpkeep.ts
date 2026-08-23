/**
 * Running the note upkeep off the editor's own change events.
 *
 * Two things make this safe to hang off `onChange`. The pass is still — given a
 * scene it has already settled it reports no change at all — so the update it
 * triggers ends the cycle rather than starting a new one. And the work is
 * deferred out of the change callback, because calling `updateScene` while
 * Excalidraw is still telling us about the last one is how integrations
 * deadlock themselves.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createExcalidrawAdapter } from "../integrations/excalidraw";
import { normaliseStickyNotes } from "./stickyNormalise";

/** Matches CaptureUpdateAction.NEVER — an automatic tidy is not an undo step. */
const CAPTURE_UPDATE_NEVER = "NEVER";

type Options = {
  excalidrawAPI: { current: any };
  canEdit: boolean;
};

export function useStickyUpkeep({ excalidrawAPI, canEdit }: Options) {
  /** The note under a resize handle on the previous change, if any. */
  const wasResizing = useRef<string | null>(null);
  const queued = useRef(false);
  const watchingEditor = useRef(false);
  const alive = useRef(true);
  const adapter = useMemo(
    () =>
      createExcalidrawAdapter({
        api: () => excalidrawAPI.current,
        container: () => null,
        canEdit: () => canEdit,
      }),
    [canEdit, excalidrawAPI],
  );

  // Set on the way in as well as cleared on the way out. React mounts an effect
  // twice in development, and a flag only ever cleared would stay cleared after
  // that second pass — the upkeep would then quietly do nothing at all, which
  // is exactly what it did until a browser test caught it.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const onSceneChange = useCallback(
    (elements: readonly any[], appState: any) => {
      if (!canEdit || !elements?.length) return;

      const resizingId = appState?.resizingElement?.id ?? null;
      // A resize that ended between the last change and this one: the size the
      // person let go of is the size the note should now defend.
      const justResized = wasResizing.current && !resizingId ? wasResizing.current : null;
      wasResizing.current = resizingId;

      // Mid-gesture. Measuring now would fight the drag and settle on a size
      // that is wrong a frame later.
      if (resizingId || appState?.newElement) return;

      const editingId = appState?.editingTextElement?.id ?? null;

      if (queued.current) return;
      queued.current = true;

      const apply = (options: {
        resized: ReadonlySet<string> | null;
        editing: ReadonlySet<string> | null;
      }) => {
        const api = excalidrawAPI.current;
        if (!api) return;
        // Contract gap (NIL-322): scene.relayout and every text capability are
        // still unsupported, and relayout cannot receive the just-resized and
        // currently-editing sets that preserve the upkeep's existing rules.
        const next = normaliseStickyNotes(api.getSceneElementsIncludingDeleted(), options);
        if (!next) return;
        api.updateScene({ elements: next, captureUpdate: CAPTURE_UPDATE_NEVER });
      };

      // Closing the text editor is the one moment this cannot hear about.
      //
      // While somebody types, Excalidraw owns the label's box and only the font
      // size is ours, so those passes leave the note at whatever height it grew
      // to. Putting it back is the job of the pass that runs once the editor is
      // gone -- and Excalidraw reports no scene change when it goes, so that
      // pass never came. The note stayed outgrown until something unrelated
      // touched the scene, which on a quiet board could be a long time and in
      // the test suite was never.
      //
      // So the end of the edit is watched for rather than waited on: one cheap
      // read of the app state per frame, only while an editor is actually open.
      const watchForEditorClosing = () => {
        if (watchingEditor.current) return;
        watchingEditor.current = true;
        const step = () => {
          const interaction = alive.current ? adapter.interaction.read() : null;
          if (!interaction?.ok) {
            watchingEditor.current = false;
            return;
          }
          if (interaction.value.editingTextElementId) {
            requestAnimationFrame(step);
            return;
          }
          watchingEditor.current = false;
          // A drag that started the instant the editor closed gets the same
          // courtesy as anywhere else: measuring mid-gesture settles on a size
          // that is wrong a frame later.
          if (interaction.value.resizingElementId || interaction.value.creatingElementId) return;
          apply({ resized: null, editing: null });
        };
        requestAnimationFrame(step);
      };

      queueMicrotask(() => {
        queued.current = false;
        if (!alive.current) return;

        apply({
          resized: justResized ? new Set([justResized]) : null,
          editing: editingId ? new Set([editingId]) : null,
        });
        if (editingId) watchForEditorClosing();
      });
    },
    [adapter, canEdit, excalidrawAPI],
  );

  return { onSceneChange };
}
