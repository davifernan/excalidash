/** Lossless, reversible scene previews for version history. */

import { openSceneDocument, sealSceneDocument, type SceneDocumentContents } from "./adapter";
import { reportFailure } from "./compatibility/diagnostics";
import type { HistoryCapability, PreviewTransaction } from "./capabilities";
import { HISTORY } from "./elements";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { SceneDocument } from "./types";
import { packageVersion } from "./version";

export type HistoryApi = {
  getSceneElementsIncludingDeleted: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  addFiles: (files: readonly unknown[]) => void;
  updateScene: (change: Record<string, unknown>) => void;
};

const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
  if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
  return result;
};

const snapshot = (api: HistoryApi): SceneDocumentContents => ({
  elements: [...(api.getSceneElementsIncludingDeleted() as readonly Record<string, unknown>[])],
  appState: { ...api.getAppState() },
  files: { ...api.getFiles() },
});

const showPreview = (api: HistoryApi, document: SceneDocumentContents): void => {
  const files = Object.values(document.files);
  if (files.length > 0) api.addFiles(files);
  api.updateScene({
    elements: [...document.elements],
    appState: { ...document.appState, collaborators: undefined },
    captureUpdate: HISTORY.never,
  });
};

const restorePrevious = (api: HistoryApi, document: SceneDocumentContents): void => {
  api.updateScene({
    elements: [...document.elements],
    appState: { ...document.appState },
    captureUpdate: HISTORY.never,
  });
  const files = Object.values(document.files);
  if (files.length > 0) api.addFiles(files);
};

export const createHistoryCapability = (getApi: () => HistoryApi | null): HistoryCapability => ({
  async beginPreview(document: SceneDocument): Promise<CapabilityResult<PreviewTransaction>> {
    const api = getApi();
    if (!api) {
      return report(
        fail("not-ready", "history.beginPreview", {
          detail: "the editor handle is not attached",
        }),
      );
    }
    const preview = openSceneDocument(document);
    if (!preview) {
      return report(
        fail("invalid-state", "history.beginPreview", {
          detail: "not a document produced by this adapter",
        }),
      );
    }

    const previousContents = snapshot(api);
    const previous = sealSceneDocument(previousContents);
    try {
      showPreview(api, preview);
    } catch (error) {
      return report(
        fail("editor-changed", "history.beginPreview", {
          detail: error instanceof Error ? error.name : "preview update threw",
        }),
      );
    }

    return ok({
      previous,
      async restore() {
        const currentApi = getApi();
        if (!currentApi) {
          return report(
            fail("not-ready", "history.restore", {
              detail: "the editor handle is not attached",
            }),
          );
        }
        if (currentApi !== api) {
          return report(
            fail("editor-changed", "history.restore", {
              detail: "the editor handle changed during the preview",
            }),
          );
        }
        try {
          restorePrevious(currentApi, previousContents);
          return ok(undefined);
        } catch (error) {
          return report(
            fail("editor-changed", "history.restore", {
              detail: error instanceof Error ? error.name : "restore update threw",
            }),
          );
        }
      },
    });
  },
});
