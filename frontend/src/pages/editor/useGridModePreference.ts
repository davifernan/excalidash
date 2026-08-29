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
  const writeInFlightRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (loadRef.current === null) {
      loadRef.current = api
        .getUserPreferences()
        .then((preferences) =>
          typeof preferences.gridModeEnabled === "boolean" ? preferences.gridModeEnabled : null,
        )
        .catch(() => null);
    }
    const initial = boardSettings.read();
    observedRef.current = initial.ok ? initial.value.gridModeEnabled : null;
    const persistLatestChange = () => {
      if (writeInFlightRef.current) return;
      void loadRef.current!.then(() => {
        const value = changedBeforeLoadRef.current;
        if (value === null || writeInFlightRef.current) return;
        changedBeforeLoadRef.current = null;
        writeInFlightRef.current = true;
        void Promise.resolve(api.updateUserPreferences({ gridModeEnabled: value }))
          .catch(() => {
            // Keep the local choice when persistence is temporarily unavailable.
          })
          .finally(() => {
            writeInFlightRef.current = false;
            // A later toggle must win even when a previous preference write is
            // still in flight.
            persistLatestChange();
          });
      });
    };
    const unsubscribe = boardSettings.subscribe((settings) => {
      const previous = observedRef.current;
      observedRef.current = settings.gridModeEnabled;
      if (previous === null || previous === settings.gridModeEnabled) return;
      if (applyingStoredRef.current === settings.gridModeEnabled) {
        applyingStoredRef.current = null;
        return;
      }
      // Keep the latest choice, not the first: several command-palette
      // toggles may land before the preference read resolves.
      changedBeforeLoadRef.current = settings.gridModeEnabled;
      persistLatestChange();
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
      // Mirror Excalidraw's native grid action: changing grid mode always
      // disables object snapping, so restoring this preference cannot create
      // a canvas-state combination the native command cannot produce.
      scene.apply([
        {
          kind: "settings",
          settings: { gridModeEnabled: stored, objectsSnapModeEnabled: false },
        },
      ]);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, boardSettings, scene]);
};
