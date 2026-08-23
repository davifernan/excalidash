/**
 * The adapter, assembled.
 *
 * One factory, one instance per editor, handed the raw handle by the host. The
 * handle arrives late -- Excalidraw calls `excalidrawAPI` after its first render
 * -- so every capability reads it through a getter rather than capturing it.
 * That is why an unattached editor reports `not-ready` instead of throwing: the
 * gap between mount and handle is a normal state, not a defect.
 */

import {
  createBoardSettingsCapability,
  createFileCapability,
  createSceneCapability,
  type RawApi,
} from "./adapter";
import type { ExcalidrawAdapter } from "./capabilities";
import { createCollaborationCapability } from "./collaboration";
import { verifySeams } from "./compatibility/seams";
import { onDiagnostic } from "./compatibility/diagnostics";
import { createInteractionCapability } from "./interaction";
import { fail, ok } from "./errors";
import { createUiCapability } from "./uiSlots";
import { createViewportCapability } from "./viewport";
import { packageVersion } from "./version";
import { createWidgetCapability } from "./widgets";

export type AdapterHost = {
  /** The imperative handle, or null until the editor hands it over. */
  api: () => unknown;
  /** The element this editor was mounted into. */
  container: () => HTMLElement | null;
  /** Whether this viewer may edit, as the host was told. */
  canEdit: () => boolean;
};

export const createExcalidrawAdapter = (host: AdapterHost): ExcalidrawAdapter => {
  const raw = <T>() => (host.api() as T | null) ?? null;

  const scene = createSceneCapability(() => raw<RawApi>());
  const interaction = createInteractionCapability(() => raw<never>());

  return {
    scene,
    text: {
      readLabel: () =>
        fail("unsupported", "text.readLabel", {
          detail: "arrives with the sticky migration",
        }),
      labelsBeingTyped: () =>
        fail("unsupported", "text.labelsBeingTyped", {
          detail: "arrives with the sticky migration",
        }),
      setLabelFontSize: () =>
        fail("unsupported", "text.setLabelFontSize", {
          detail: "arrives with the sticky migration",
        }),
    },
    boardSettings: createBoardSettingsCapability(() => raw<RawApi>()),
    selection: {
      read: () => {
        const api = raw<RawApi>();
        if (!api) return fail("not-ready", "selection.read");
        const ids = api.getAppState().selectedElementIds;
        return ok({
          selectedIds:
            ids && typeof ids === "object"
              ? (Object.keys(ids as Record<string, unknown>) as never)
              : [],
          allSelected: false,
        });
      },
      subscribe: (listener) => {
        const api = raw<RawApi>();
        if (!api) return () => {};
        return api.onChange(() => {
          const ids = api.getAppState().selectedElementIds;
          listener({
            selectedIds:
              ids && typeof ids === "object"
                ? (Object.keys(ids as Record<string, unknown>) as never)
                : [],
            allSelected: false,
          });
        });
      },
      anchorAt: () =>
        fail("unsupported", "selection.anchorAt", { detail: "arrives with comments in M3" }),
    },
    files: createFileCapability(() => raw<RawApi>()),
    viewport: createViewportCapability(() => raw<never>()),
    collaboration: createCollaborationCapability(() => raw<never>()),
    interaction,
    widgets: createWidgetCapability(() => ({
      getAppState: () => raw<RawApi>()?.getAppState() ?? {},
      canEdit: host.canEdit,
    })),
    export: {
      exportableDocument: () =>
        fail("unsupported", "export.exportableDocument", {
          detail: "arrives with the export migration",
        }),
      toSvg: async () =>
        fail("unsupported", "export.toSvg", { detail: "arrives with the export migration" }),
    },
    history: {
      beginPreview: async () =>
        fail("unsupported", "history.beginPreview", {
          detail: "arrives with the version-history migration",
        }),
    },
    ui: createUiCapability(() => ({
      container: host.container,
      isEditingLabelOf: (id) => {
        const state = interaction.read();
        return state.ok && state.value.editingTextContainerId === id;
      },
      // Without these two the library capability compiles, reports `unsupported`
      // at runtime, and the caller quietly falls back to the raw handle -- which
      // is the boundary hole this layer exists to close.
      updateLibrary: (payload) => {
        const api = raw<RawApi & { updateLibrary?: (p: Record<string, unknown>) => Promise<unknown> }>();
        return api?.updateLibrary
          ? api.updateLibrary(payload)
          : Promise.reject(new Error("updateLibrary is not attached"));
      },
      readLibraryItems: () => {
        const state = raw<RawApi>()?.getAppState();
        const items = state?.libraryItems;
        return Array.isArray(items) ? items : [];
      },
    })),
    compatibility: {
      packageVersion,
      verifySeams: () => ok(verifySeams(host.api(), host.container())),
      onDiagnostic,
    },
  };
};

export type { ExcalidrawAdapter } from "./capabilities";
export * from "./types";
