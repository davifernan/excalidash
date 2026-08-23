/**
 * The two things about Excalidraw's own UI that our island has to follow.
 *
 * Zen mode is what replaced our old auto-hide: instead of chrome that vanishes
 * on a timer and comes back through a five pixel strip, Alt+Z takes everything
 * away deliberately and gives it back the same way. Excalidraw slides its own
 * panels out; ours has to go with them, or "hide everything" quietly means
 * "hide everything except that one island", which reads as a bug.
 *
 * Reading it from `appState` would mean threading editor state through a
 * presentational component and re-rendering the editor on every scene change —
 * the shape of change that has already caused one render loop in this codebase.
 * Watching for the class Excalidraw itself puts on its toolbar is cheaper and
 * fires exactly when the mode flips.
 *
 * The second signal is the mobile layout. Below Excalidraw's own breakpoint the
 * tool row moves to the top of the screen, straight underneath where our island
 * sits -- it covered the first four tools. There is no room for both, so on a
 * phone the island stands down and the back route lives in the main menu, which
 * moves to the bottom on that layout anyway.
 *
 * Both are dependencies on Excalidraw's markup rather than its API, taken
 * knowingly and in the same spirit as the sticky note button: if a class is ever
 * renamed, the island stops hiding. Visible, small, and not a silent failure.
 */
import { useEffect, useState } from "react";

import { observeStructure, readChrome } from "../../integrations/excalidraw/domBridge";
import type React from "react";

export type ExcalidrawUiState = { zenMode: boolean; mobile: boolean };

export function useExcalidrawUiState(
  containerRef: React.RefObject<HTMLElement>,
): ExcalidrawUiState {
  const [state, setState] = useState<ExcalidrawUiState>({ zenMode: false, mobile: false });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const read = () => {
      const { zenMode, mobile } = readChrome(container);
      setState((current) =>
        current.zenMode === zenMode && current.mobile === mobile ? current : { zenMode, mobile },
      );
    };

    read();
    return observeStructure(container, read);
  }, [containerRef]);

  return state;
}
