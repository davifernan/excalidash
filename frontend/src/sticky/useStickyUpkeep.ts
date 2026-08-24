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
import { useCallback, useEffect, useRef } from "react";
import { openSceneDocument, sealSceneDocument } from "../integrations/excalidraw/adapter";
import type {
  InteractionCapability,
  SceneCapability,
} from "../integrations/excalidraw/capabilities";
import { normaliseStickyNotes } from "./stickyNormalise";
import { log } from "../logging";

type Options = {
  canEdit: boolean;
  interaction: Pick<InteractionCapability, "read">;
  scene: Pick<SceneCapability, "apply" | "readDocument">;
};

export function useStickyUpkeep({ canEdit, interaction, scene }: Options) {
  /** The note under a resize handle on the previous change, if any. */
  const wasResizing = useRef<string | null>(null);
  const queued = useRef(false);
  const watchingEditor = useRef(false);
  const alive = useRef(true);

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
        // Read the scene now, not the list this callback was handed.
        //
        // The pass that matters most runs *after* the text editor closes, and
        // by then the captured list is one change old: it still holds the note
        // as it was before anyone typed into it. Normalising that leaves the
        // writing at full size, which is the one thing this upkeep exists to
        // prevent. The raw version read the editor fresh at exactly this
        // moment; so does this one.
        const current = scene.readDocument({ includeDeleted: true });
        const source = current.ok
          ? ((openSceneDocument(current.value)?.elements ?? elements) as readonly any[])
          : elements;
        const next = normaliseStickyNotes(source, options);
        if (!next) return;
        const applied = scene.apply(
          [
            {
              kind: "replaceDocument",
              document: sealSceneDocument({ elements: next, appState: {}, files: {} }),
            },
          ],
          { capture: "never" },
        );
        // notify: false -- this upkeep pass runs automatically on every
        // qualifying scene change, not from a direct user action; a toast
        // per occurrence would spam rather than inform if it kept failing.
        if (!applied.ok)
          log.error("[Sticky] Failed to normalise notes", { result: applied }, { notify: false });
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
          const state = alive.current ? interaction.read() : null;
          if (!state?.ok) {
            watchingEditor.current = false;
            return;
          }
          if (state.value.editingTextElementId) {
            requestAnimationFrame(step);
            return;
          }
          watchingEditor.current = false;
          // A drag that started the instant the editor closed gets the same
          // courtesy as anywhere else: measuring mid-gesture settles on a size
          // that is wrong a frame later.
          if (state.value.resizingElementId || state.value.creatingElementId) return;
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
    [canEdit, interaction, scene],
  );

  return { onSceneChange };
}
