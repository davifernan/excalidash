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
 *
 * `toggle` always awaits the same in-flight read before computing what to
 * write (Hans-Friedrich, PR #228): a click that lands before
 * `getUserPreferences()` resolves used to fall back to "every known id" as
 * its base, so it could write over -- and then permanently discard, via
 * `hasWrittenRef` -- an already-saved selection the read just hadn't
 * delivered yet. Routing every write through the same promise the read
 * effect subscribes to, and reading the base out of React state via a
 * functional updater rather than a closed-over variable, means a toggle can
 * only ever start from the real stored selection (or the real "never
 * customized" default), never from a guess made while that answer was still
 * in flight.
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
  // Created once per hook instance (not per render) and shared by the load
  // effect and every `toggle` call, so both always agree on the same
  // eventual read instead of racing two independent fetches.
  const loadRef = useRef<Promise<readonly EditorFeatureId[] | null> | null>(null);
  if (loadRef.current === null) {
    loadRef.current = api
      .getUserPreferences()
      .then((preferences) =>
        Array.isArray(preferences.toolbarFeatureIds)
          ? (preferences.toolbarFeatureIds as EditorFeatureId[])
          : null,
      )
      .catch(() => null);
  }
  // Sourced from a click, not the read -- guards the read's own `setStored`
  // from clobbering a selection a `toggle` already wrote once the read
  // eventually resolves.
  const hasWrittenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadRef.current!.then((loaded) => {
      if (cancelled || hasWrittenRef.current || loaded === null) return;
      // Anonymous/guest viewers and offline/failed reads keep every
      // applicable feature visible -- the same tolerant fallback
      // ThemeContext uses.
      setStored(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledIds = stored === null ? knownIds : stored.filter((id) => knownIds.includes(id));

  const toggle = useCallback(
    (id: EditorFeatureId) => {
      hasWrittenRef.current = true;
      void loadRef.current!.then((loaded) => {
        setStored((current) => {
          const base = current ?? loaded ?? knownIds;
          const next = base.includes(id)
            ? base.filter((candidate) => candidate !== id)
            : [...base, id];
          api.updateUserPreferences({ toolbarFeatureIds: [...next] }).catch(() => {
            // Keep the local choice even when the write fails/offline -- it
            // just does not survive a reload, same tradeoff as ThemeContext.
          });
          return next;
        });
      });
    },
    [knownIds],
  );

  return {
    isEnabled: (id) => enabledIds.includes(id),
    toggle,
  };
};
