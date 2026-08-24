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
  openSceneDocument,
  sealSceneDocument,
  type RawApi,
} from "./adapter";
import type { ExcalidrawAdapter } from "./capabilities";
import type { ElementId } from "./types";
import { createCollaborationCapability } from "./collaboration";
import { verifySeams } from "./compatibility/seams";
import { onDiagnostic } from "./compatibility/diagnostics";
import { createInteractionCapability } from "./interaction";
import { createExportCapability } from "./export";
import { createHistoryCapability } from "./history";
import { fail, ok } from "./errors";
import { createTextContainerCapability } from "./text";
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
    text: createTextContainerCapability(() => raw<RawApi>()),
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
      anchorAt: (point) => {
        const api = raw<RawApi>();
        if (!api) return fail("not-ready", "selection.anchorAt");
        const found = scene.summaries();
        if (!found.ok) return fail(found.code, "selection.anchorAt", { detail: found.detail });
        // TOLERANCE softens near-zero-height elements (a horizontal arrow's
        // bounding box is a sliver) that a bare box test would leave all but
        // unclickable.
        const TOLERANCE = 6;
        const hits = (el: (typeof found.value)[number]): boolean => {
          const cx = el.x + el.width / 2;
          const cy = el.y + el.height / 2;
          const cos = Math.cos(-el.angle);
          const sin = Math.sin(-el.angle);
          const dx = point.x - cx;
          const dy = point.y - cy;
          const localX = dx * cos - dy * sin;
          const localY = dx * sin + dy * cos;
          return (
            Math.abs(localX) <= el.width / 2 + TOLERANCE &&
            Math.abs(localY) <= el.height / 2 + TOLERANCE
          );
        };
        // Topmost first: Excalidraw returns elements back-to-front, and a
        // click should anchor to whatever the viewer actually sees under the
        // pointer. Frames are a container, not content -- a click on a shape
        // inside a frame must anchor to the shape, not the frame it happens
        // to sit in, so frames are only considered once nothing else matched.
        let frameHit: ElementId | null = null;
        for (let i = found.value.length - 1; i >= 0; i--) {
          const el = found.value[i];
          if (!hits(el)) continue;
          if (el.type === "frame") {
            if (frameHit === null) frameHit = el.id as ElementId;
            continue;
          }
          return ok(el.id as ElementId);
        }
        return ok(frameHit);
      },
    },
    files: createFileCapability(() => raw<RawApi>()),
    viewport: createViewportCapability(() => raw<never>()),
    collaboration: createCollaborationCapability(() => raw<never>()),
    interaction,
    widgets: createWidgetCapability(() => ({
      getAppState: () => raw<RawApi>()?.getAppState() ?? {},
      canEdit: host.canEdit,
    })),
    export: createExportCapability(openSceneDocument, sealSceneDocument),
    history: createHistoryCapability(() => raw<RawApi>()),
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
        const api = raw<
          RawApi & { updateLibrary?: (p: Record<string, unknown>) => Promise<unknown> }
        >();
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
