/**
 * The adapter: the only code that knows the raw Excalidraw API.
 *
 * Everything here converts between what the editor offers and what the
 * capabilities promise. Two rules hold throughout:
 *
 *   - Nothing raw leaves. A SceneDocument is opaque and a summary is a copy;
 *     no capability hands out an object the editor still owns.
 *   - A failure is a value. Nothing here throws at a consumer; a seam that is
 *     gone reports `unsupported`, a handle that is not attached yet reports
 *     `not-ready`, and both reach the diagnostics sink on the way out.
 */

import { reportFailure } from "./compatibility/diagnostics";
import type { BoardSettingsCapability, FileCapability, SceneCapability } from "./capabilities";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type {
  BoardSettings,
  ElementId,
  ElementSummary,
  FileId,
  HistoryCapture,
  NewElement,
  PersistedScene,
  SceneDocument,
  SceneFile,
  SceneOp,
  Unsubscribe,
} from "./types";
import { packageVersion } from "./version";

/** The handle the host hands over. Untyped by the package, typed here. */
export type RawApi = {
  getSceneElements: () => readonly unknown[];
  getSceneElementsIncludingDeleted: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  addFiles: (files: readonly unknown[]) => void;
  updateScene: (change: Record<string, unknown>) => void;
  onChange: (listener: () => void) => Unsubscribe;
};

/** What a SceneDocument actually is, on this side of the boundary only. */
export type SceneDocumentContents = {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

/**
 * The contents live beside the handle, not on it.
 *
 * A WeakMap keyed on the handle means the handle itself has no own properties:
 * nothing can be read off it, serialised out of it, or reached by walking it.
 * Only this module holds the key, so "opaque" is enforced rather than asked for.
 */
const inner = new WeakMap<object, SceneDocumentContents>();

const seal = (value: SceneDocumentContents): SceneDocument => {
  const handle = Object.freeze({}) as unknown as SceneDocument;
  inner.set(handle as unknown as object, value);
  return handle;
};

const open = (document: SceneDocument): SceneDocumentContents | null =>
  document ? (inner.get(document as unknown as object) ?? null) : null;

/** Shared only by capabilities that must operate on the complete opaque document. */
export const sealSceneDocument = (value: SceneDocumentContents): SceneDocument => seal(value);
export const openSceneDocument = (document: SceneDocument): SceneDocumentContents | null =>
  open(document);

const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
  if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
  return result;
};

const CAPTURE: Record<HistoryCapture, string> = {
  immediate: "IMMEDIATELY",
  never: "NEVER",
  eventually: "EVENTUALLY",
};

const asId = (value: unknown): ElementId => String(value) as ElementId;

const optionalId = (value: unknown): ElementId | null =>
  typeof value === "string" && value.length > 0 ? (value as ElementId) : null;

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The read projection.
 *
 * A copy, field by field. Returning the editor's own object would hand product
 * code a live, mutable element and quietly undo the whole boundary.
 */
export const summarise = (element: Record<string, unknown>): ElementSummary => ({
  id: asId(element.id),
  type: typeof element.type === "string" ? element.type : "unknown",
  x: num(element.x, 0),
  y: num(element.y, 0),
  width: num(element.width, 0),
  height: num(element.height, 0),
  angle: num(element.angle, 0),
  isDeleted: element.isDeleted === true,
  frameId: optionalId(element.frameId),
  containerId: optionalId(element.containerId),
  link: typeof element.link === "string" ? element.link : null,
  // Deep-copied like everything else here. The Readonly<> on the type is a
  // compile-time promise and nothing at runtime; handing the editor's own
  // object out would let product code mutate a nested field and have it land on
  // the live element -- the exact thing this projection exists to prevent.
  customData:
    element.customData && typeof element.customData === "object"
      ? (structuredClone(element.customData) as Record<string, unknown>)
      : null,
});

export const readBoardSettings = (appState: Record<string, unknown>): BoardSettings => ({
  gridModeEnabled: appState.gridModeEnabled === true,
  gridSize: typeof appState.gridSize === "number" ? appState.gridSize : null,
  gridStep: typeof appState.gridStep === "number" ? appState.gridStep : null,
  objectsSnapModeEnabled: appState.objectsSnapModeEnabled === true,
  viewBackgroundColor:
    typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : "#ffffff",
  theme: appState.theme === "dark" ? "dark" : "light",
});

const toSceneFile = (id: string, file: Record<string, unknown>): SceneFile => ({
  id: id as FileId,
  mimeType: typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream",
  dataURL: typeof file.dataURL === "string" ? file.dataURL : "",
  created: num(file.created, 0),
});

/**
 * Turn a list of operations into ONE editor update.
 *
 * The ordering rules live here rather than at the call sites, which is the
 * point: a frame's children sit immediately before it in the element list, so
 * an insert that names a frame goes before that frame rather than at the end.
 */
/** Which operations need to see the scene that is already there. */
const NEEDS_CURRENT: ReadonlySet<SceneOp["kind"]> = new Set(["insert", "patch", "remove"]);

export const opsNeedCurrentScene = (ops: readonly SceneOp[]): boolean =>
  ops.some((op) => NEEDS_CURRENT.has(op.kind));

export const buildSceneUpdate = (
  current: readonly Record<string, unknown>[],
  ops: readonly SceneOp[],
  capture?: HistoryCapture,
): Record<string, unknown> | CapabilityFailure => {
  let elements: Record<string, unknown>[] | null = null;
  const appState: Record<string, unknown> = {};
  let touchedElements = false;

  const workingSet = () => {
    if (elements === null) elements = [...current];
    touchedElements = true;
    return elements;
  };

  for (const op of ops) {
    switch (op.kind) {
      case "insert": {
        const list = workingSet();
        const made = op.elements.map(fromNewElement);
        if (op.before) {
          const at = list.findIndex((element) => element.id === op.before);
          if (at < 0) {
            return fail("invalid-state", "scene.apply", {
              detail: "insert names an element that is not in the scene",
            });
          }
          list.splice(at, 0, ...made);
        } else {
          list.push(...made);
        }
        break;
      }
      case "patch": {
        const list = workingSet();
        const at = list.findIndex((element) => element.id === op.id);
        if (at < 0) {
          return fail("invalid-state", "scene.apply", {
            detail: "patch names an element that is not in the scene",
          });
        }
        list[at] = { ...list[at], ...op.changes };
        break;
      }
      case "replaceElements": {
        elements = [...(op.elements as Record<string, unknown>[])];
        touchedElements = true;
        break;
      }
      case "remove": {
        const gone = new Set<string>(op.ids as readonly string[]);
        const list = workingSet();
        elements = list.map((element) =>
          gone.has(String(element.id)) ? { ...element, isDeleted: true } : element,
        );
        break;
      }
      case "replaceDocument": {
        const document = open(op.document);
        if (!document) {
          return fail("invalid-state", "scene.apply", {
            detail: "replaceDocument was handed a document this adapter did not produce",
          });
        }
        elements = [...document.elements];
        touchedElements = true;
        Object.assign(appState, document.appState);
        break;
      }
      case "select": {
        appState.selectedElementIds = Object.fromEntries(
          op.ids.map((id) => [String(id), true] as const),
        );
        break;
      }
      case "itemDefaults": {
        if (op.fontSize !== undefined) appState.currentItemFontSize = op.fontSize;
        if (op.strokeColor !== undefined) appState.currentItemStrokeColor = op.strokeColor;
        if (op.backgroundColor !== undefined) {
          appState.currentItemBackgroundColor = op.backgroundColor;
        }
        break;
      }
      case "settings": {
        Object.assign(appState, op.settings);
        break;
      }
      case "viewport": {
        if (op.zoom !== undefined) appState.zoom = { value: op.zoom };
        if (op.scrollX !== undefined) appState.scrollX = op.scrollX;
        if (op.scrollY !== undefined) appState.scrollY = op.scrollY;
        break;
      }
      case "collaborators": {
        // Handled by the collaboration capability, which owns the map.
        return fail("invalid-state", "scene.apply", {
          detail: "collaborator changes go through the collaboration capability",
        });
      }
    }
  }

  const update: Record<string, unknown> = {};
  if (touchedElements && elements !== null) update.elements = elements;
  if (Object.keys(appState).length > 0) update.appState = appState;
  if (capture) update.captureUpdate = CAPTURE[capture];
  return update;
};

/**
 * An element this application is creating, as Excalidraw wants it.
 *
 * Only the fields the contract names are set. Everything else Excalidraw fills
 * in itself, which is the reason NewElement is small: the adapter should not be
 * guessing at defaults the editor already has.
 */
const fromNewElement = (element: NewElement): Record<string, unknown> => ({
  // Everything the caller set, then the fields this contract names.
  //
  // The first version was a whitelist of eleven fields, and it dropped
  // everything else on the floor. A sticky note arrives here fully built --
  // angle, seed, roundness, font size, the bound-text bookkeeping -- and the
  // whitelist kept none of it, so the note went in as a bare rectangle and the
  // label editor had nothing to open. That is the same mistake the review found
  // in SceneElement, repeated one function further in: a projection used where
  // a complete object was needed.
  ...(element as unknown as Record<string, unknown>),
  id: element.id,
  type: element.type,
  x: element.x,
  y: element.y,
  width: element.width,
  height: element.height,
  ...(element.frameId !== undefined ? { frameId: element.frameId } : {}),
});

export const createSceneCapability = (getApi: () => RawApi | null): SceneCapability => {
  const notReady = <T>(seam: string): CapabilityResult<T> =>
    report(fail("not-ready", seam, { detail: "the editor handle is not attached" }));

  const readRaw = (includeDeleted: boolean, api: RawApi) =>
    (includeDeleted
      ? api.getSceneElementsIncludingDeleted()
      : api.getSceneElements()) as readonly Record<string, unknown>[];

  return {
    readDocument(options) {
      const api = getApi();
      if (!api) return notReady("scene.readDocument");
      return ok(
        seal({
          elements: readRaw(options?.includeDeleted ?? true, api),
          appState: api.getAppState(),
          files: api.getFiles(),
        }),
      );
    },

    summaries(options) {
      const api = getApi();
      if (!api) return notReady("scene.summaries");
      return ok(readRaw(options?.includeDeleted ?? false, api).map(summarise));
    },

    summaryById(id) {
      const api = getApi();
      if (!api) return notReady("scene.summaryById");
      const found = readRaw(true, api).find((element) => element.id === id);
      return ok(found ? summarise(found) : null);
    },

    apply(ops, options) {
      const api = getApi();
      if (!api) return notReady("scene.apply");
      // Only read the scene when an operation actually needs it. Replacing the
      // element list wholesale does not, and reading anyway would make every
      // caller depend on a read its own operation never uses.
      const current = opsNeedCurrentScene(ops) ? readRaw(true, api) : [];
      const update = buildSceneUpdate(current, ops, options?.capture);
      if ("ok" in update && update.ok === false) return report(update as CapabilityFailure);
      api.updateScene(update as Record<string, unknown>);
      return ok(undefined);
    },

    async applySettled(ops, options) {
      const applied = this.apply(ops, options);
      if (!applied.ok) return applied;
      // The editor commits through React state; the change is not observable
      // in the same tick. Waiting a frame here is what several consumers do by
      // hand today, against internals they should not know about.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok(undefined);
    },

    subscribe(listener) {
      const api = getApi();
      if (!api) return () => {};
      return api.onChange(listener);
    },

    toPersisted(document) {
      const opened = open(document);
      if (!opened) {
        return report(
          fail("invalid-state", "scene.toPersisted", {
            detail: "not a document produced by this adapter",
          }),
        );
      }
      return ok(seal(opened) as unknown as PersistedScene);
    },

    fromPersisted(payload) {
      const opened = open(payload as unknown as SceneDocument);
      if (!opened) {
        return report(
          fail("invalid-state", "scene.fromPersisted", {
            detail: "not a payload produced by this adapter",
          }),
        );
      }
      return ok(seal(opened));
    },

    reconcile() {
      // Deliberately unimplemented until the persistence consumer migrates:
      // reconciliation has to reuse the editor's own merge, and wiring it
      // before there is a caller would be guessing at the shape.
      return report(
        fail("unsupported", "scene.reconcile", {
          detail: "arrives with the persistence migration",
        }),
      );
    },

    relayout() {
      return report(
        fail("unsupported", "scene.relayout", {
          detail: "arrives with the sticky migration",
        }),
      );
    },
  };
};

export const createBoardSettingsCapability = (
  getApi: () => RawApi | null,
): BoardSettingsCapability => ({
  read() {
    const api = getApi();
    if (!api) return report(fail("not-ready", "boardSettings.read"));
    return ok(readBoardSettings(api.getAppState()));
  },
  subscribe(listener) {
    const api = getApi();
    if (!api) return () => {};
    return api.onChange(() => listener(readBoardSettings(api.getAppState())));
  },
});

export const createFileCapability = (getApi: () => RawApi | null): FileCapability => {
  /**
   * One wrapper per handle, however many consumers subscribe.
   *
   * A `WeakSet` rather than a flag: the editor hands out a new API object on
   * remount, and a flag would leave the second one unwrapped. Weak so a handle
   * that goes away takes its entry with it.
   */
  const wrapped = new WeakSet<object>();
  const listeners = new Set<() => void>();

  const ensureWrapped = (api: RawApi | null) => {
    if (!api || typeof api.addFiles !== "function" || wrapped.has(api as object)) return;
    wrapped.add(api as object);
    const original = api.addFiles.bind(api);
    (api as { addFiles: (files: unknown) => void }).addFiles = (files: unknown) => {
      // The editor takes the files first. A listener that ran before this would
      // read the map as it was and miss exactly the change it was told about.
      original(Array.isArray(files) ? files : Object.values((files as object) ?? {}));
      for (const listener of listeners) listener();
    };
  };

  return {
    read() {
      const api = getApi();
      if (!api) return report(fail("not-ready", "files.read"));
      const raw = api.getFiles() || {};
      const out: Record<string, SceneFile> = {};
      for (const [id, file] of Object.entries(raw)) {
        out[id] = toSceneFile(id, file as Record<string, unknown>);
      }
      return ok(out as Readonly<Record<FileId, SceneFile>>);
    },

    add(files) {
      const api = getApi();
      if (!api) return report(fail("not-ready", "files.add"));
      api.addFiles(files.map((file) => ({ ...file })));
      return ok(undefined);
    },

    deltaAgainst(confirmed) {
      const api = getApi();
      if (!api) return report(fail("not-ready", "files.deltaAgainst"));
      const raw = api.getFiles() || {};
      const missing: SceneFile[] = [];
      for (const [id, file] of Object.entries(raw)) {
        if (!confirmed.has(id as FileId)) {
          missing.push(toSceneFile(id, file as Record<string, unknown>));
        }
      }
      return ok(missing);
    },

    onFilesAdded(listener) {
      ensureWrapped(getApi());
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
