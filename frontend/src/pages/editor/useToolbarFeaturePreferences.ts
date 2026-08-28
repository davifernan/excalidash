/**
 * Which feature-registry entries a viewer keeps in the bottom-right toolbar
 * (NIL-655), persisted the same way theme and dashboard sort already are --
 * `User.preferences` via `/auth/preferences` (`ThemeContext.tsx` is the
 * existing reference for this exact read-then-write shape). No second
 * per-viewer settings store: NIL-655's own kickoff points at this one after
 * noting the same gap on NIL-657 (grid setting not persisted).
 *
 * `undefined` (never customized) and `[]` (deliberately cleared) are
 * different states: the former means "everything applicable is on", the
 * latter means the viewer actually unchecked everything. That is why this
 * hook tracks the stored list as `string[] | null` rather than defaulting
 * eagerly -- `null` is "not customized yet", not "empty".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../api";
import type { EditorFeatureId } from "./featureRegistry";

export type ToolbarFeatureSelection = {
  readonly isEnabled: (id: EditorFeatureId) => boolean;
  readonly toggle: (id: EditorFeatureId) => void;
};

export const useToolbarFeaturePreferences = (
  knownIds: readonly EditorFeatureId[],
): ToolbarFeatureSelection => {
  const [stored, setStored] = useState<readonly EditorFeatureId[] | null>(null);
  // Guards a write started before the read resolved from clobbering it with
  // the read's now-stale snapshot.
  const hasWrittenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getUserPreferences()
      .then((preferences) => {
        if (cancelled || hasWrittenRef.current) return;
        if (Array.isArray(preferences.toolbarFeatureIds)) {
          setStored(preferences.toolbarFeatureIds as EditorFeatureId[]);
        }
      })
      .catch(() => {
        // Anonymous/guest viewers and offline reads keep every applicable
        // feature visible -- the same tolerant fallback ThemeContext uses.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledIds = stored === null ? knownIds : stored.filter((id) => knownIds.includes(id));

  const toggle = useCallback(
    (id: EditorFeatureId) => {
      const current = stored === null ? knownIds : stored;
      const next = current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id];
      hasWrittenRef.current = true;
      setStored(next);
      api.updateUserPreferences({ toolbarFeatureIds: [...next] }).catch(() => {
        // Keep the local choice even when the write fails/offline -- it
        // just does not survive a reload, same tradeoff as ThemeContext.
      });
    },
    [stored, knownIds],
  );

  return {
    isEnabled: (id) => enabledIds.includes(id),
    toggle,
  };
};
