/**
 * UI: the places this application puts its own controls inside the editor.
 *
 * Two kinds, and the difference matters. The official slots -- MainMenu, Footer,
 * Sidebar, the top-right cluster -- are props and children the editor offers,
 * and the host fills them. Everything else is a portal into markup Excalidraw
 * never promised, and those go through the DOM bridge with a fallback.
 */

import { reportFailure } from "./compatibility/diagnostics";
import type { ChromeState, UiCapability } from "./capabilities";
import * as domBridge from "./domBridge";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { ElementId, Unsubscribe } from "./types";
import { packageVersion } from "./version";

export type UiApi = {
  container: () => HTMLElement | null;
  /** Is the editor editing this element's label right now? */
  isEditingLabelOf: (id: ElementId) => boolean;
  updateLibrary?: (payload: Record<string, unknown>) => Promise<unknown>;
  readLibraryItems?: () => readonly unknown[];
};

export const createUiCapability = (getApi: () => UiApi | null): UiCapability => {
  const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
    if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
    return result;
  };

  return {
    overlayRoot() {
      const api = getApi();
      if (!api) return report(fail("not-ready", "ui.overlayRoot"));
      return domBridge.findRoot(api.container());
    },

    toolbarSlot() {
      const api = getApi();
      if (!api) {
        return report(fail("not-ready", "ui.toolbarSlot", { fallback: "main-menu" }));
      }
      return domBridge.findToolbarSlot(api.container());
    },

    readChrome() {
      const api = getApi();
      if (!api) return report(fail("not-ready", "ui.readChrome"));
      return ok(domBridge.readChrome(api.container()));
    },

    subscribeChrome(listener: (chrome: ChromeState) => void): Unsubscribe {
      const api = getApi();
      if (!api) return () => {};
      const container = api.container();
      const emit = () => listener(domBridge.readChrome(container));
      emit();
      return domBridge.observeStructure(container, emit);
    },

    async importLibrary(source, options) {
      const api = getApi();
      if (!api?.updateLibrary) {
        return report(
          fail("unsupported", "ui.importLibrary", {
            detail: "this build offers no library API",
          }),
        );
      }
      try {
        await api.updateLibrary(
          source instanceof Blob
            ? { libraryItems: source, merge: options?.merge ?? true, openLibraryMenu: false }
            : { libraryItems: source, merge: options?.merge ?? true },
        );
        return ok(api.readLibraryItems?.() ?? []);
      } catch (error) {
        return report(
          fail("invalid-state", "ui.importLibrary", {
            detail: error instanceof Error ? error.name : "updateLibrary threw",
          }),
        );
      }
    },

    beginTextEditing(id, options) {
      const api = getApi();
      if (!api) {
        return Promise.resolve(
          report(fail("not-ready", "ui.beginTextEditing", { fallback: "manual-selection" })),
        );
      }
      return domBridge.pressEnterToEditLabel(api.container(), () => api.isEditingLabelOf(id), {
        timeoutMs: options?.timeoutMs,
      });
    },
  };
};
