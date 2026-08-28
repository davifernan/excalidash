import { useEffect, useRef } from "react";
import * as api from "../../api";
import type {
  BoardSettingsCapability,
  SceneCapability,
} from "../../integrations/excalidraw/capabilities";

/**
 * Makes the native command-palette grid switch a user preference.
 *
 * The initial read and a very early toggle share one promise. That matters:
 * without it, a toggle while the read is pending can write the temporary
 * canvas value back over the stored user preference (the NIL-655 race).
 */
export const useGridModePreference = ({
  active,
  boardSettings,
  scene,
}: {
  active: boolean;
  boardSettings: BoardSettingsCapability;
  scene: SceneCapability;
}): void => {
  const loadRef = useRef<Promise<boolean | null> | null>(null);
  const observedRef = useRef<boolean | null>(null);
  const changedBeforeLoadRef = useRef<boolean | null>(null);
  const applyingStoredRef = useRef<boolean | null>(null);

  if (loadRef.current === null) {
    loadRef.current = api
      .getUserPreferences()
      .then((preferences) =>
        typeof preferences.gridModeEnabled === "boolean" ? preferences.gridModeEnabled : null,
      )
      .catch(() => null);
  }

  useEffect(() => {
    if (!active) return;
    const initial = boardSettings.read();
    observedRef.current = initial.ok ? initial.value.gridModeEnabled : null;
    const unsubscribe = boardSettings.subscribe((settings) => {
      const previous = observedRef.current;
      observedRef.current = settings.gridModeEnabled;
      if (previous === null || previous === settings.gridModeEnabled) return;
      if (applyingStoredRef.current === settings.gridModeEnabled) return;
      if (changedBeforeLoadRef.current === null)
        changedBeforeLoadRef.current = settings.gridModeEnabled;
      void loadRef.current!.then(() => {
        const value = changedBeforeLoadRef.current;
        if (value === null) return;
        changedBeforeLoadRef.current = null;
        void api.updateUserPreferences({ gridModeEnabled: value });
      });
    });

    let cancelled = false;
    void loadRef.current!.then((stored) => {
      if (cancelled || stored === null) return;
      // A real interaction while the request was pending wins; it is then
      // persisted after this same read rather than starting from a guess.
      if (changedBeforeLoadRef.current !== null) return;
      const current = boardSettings.read();
      if (!current.ok || current.value.gridModeEnabled === stored) return;
      applyingStoredRef.current = stored;
      scene.apply([{ kind: "settings", settings: { gridModeEnabled: stored } }]);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, boardSettings, scene]);
};
