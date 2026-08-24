/**
 * What this application expects the installed Excalidraw to still offer.
 *
 * A canary run installs a different version and asks this. Without it, an
 * upgrade is checked only by the paths the tests happen to walk -- and the
 * seams that break quietly are exactly the ones no test walks.
 */

import * as pkg from "@excalidraw/excalidraw";

import type { SeamReport } from "../capabilities";
import { INTERNAL_SELECTORS } from "../domBridge";

/** Named exports this application calls. Losing one is a hard incompatibility. */
export const EXPECTED_EXPORTS = [
  "Excalidraw",
  "Footer",
  "MainMenu",
  "convertToExcalidrawElements",
  "exportToSvg",
  "getVisibleSceneBounds",
  "newElementWith",
  "restoreElements",
  "sceneCoordsToViewportCoords",
  "viewportCoordsToSceneCoords",
  "zoomToFitBounds",
  "CaptureUpdateAction",
  "languages",
  "useI18n",
] as const;

/** Methods on the imperative handle. */
export const EXPECTED_API_METHODS = [
  "getAppState",
  "getSceneElements",
  "getSceneElementsIncludingDeleted",
  "getFiles",
  "addFiles",
  "updateScene",
  "onChange",
  "onPointerDown",
  "setActiveTool",
  "updateLibrary",
  "onUserFollow",
  "onScrollChange",
] as const;

export type ExpectedApiMethod = (typeof EXPECTED_API_METHODS)[number];

type ApiMethodProbe = {
  readonly invoke: (handle: Record<string, (...args: never[]) => unknown>) => unknown;
  readonly accepts: (value: unknown) => boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  isObject(value) && typeof value.then === "function";

const isSynchronousObject = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && !Array.isArray(value) && !isThenable(value);

const isVoid = (value: unknown): boolean => value === undefined;

/**
 * The harmless call each raw API seam must survive, and the result shape our
 * adapter actually consumes. Keeping the probes beside the names prevents a
 * method that still exists but changed from a value to a Promise (or from an
 * unsubscribe function to void) from passing the Canary.
 */
const API_METHOD_PROBES = {
  getAppState: { invoke: (api) => api.getAppState(), accepts: isSynchronousObject },
  getSceneElements: { invoke: (api) => api.getSceneElements(), accepts: Array.isArray },
  getSceneElementsIncludingDeleted: {
    invoke: (api) => api.getSceneElementsIncludingDeleted(),
    accepts: Array.isArray,
  },
  getFiles: {
    invoke: (api) => api.getFiles(),
    accepts: isSynchronousObject,
  },
  addFiles: { invoke: (api) => api.addFiles([] as never), accepts: isVoid },
  updateScene: { invoke: (api) => api.updateScene({} as never), accepts: isVoid },
  onChange: {
    invoke: (api) => api.onChange((() => {}) as never),
    accepts: (value) => typeof value === "function",
  },
  onPointerDown: {
    invoke: (api) => api.onPointerDown((() => {}) as never),
    accepts: (value) => typeof value === "function",
  },
  setActiveTool: {
    invoke: (api) =>
      api.setActiveTool(
        (api.getAppState() as { activeTool?: unknown } | undefined)?.activeTool as never,
      ),
    accepts: isVoid,
  },
  updateLibrary: {
    invoke: (api) => api.updateLibrary({ libraryItems: [], merge: true } as never),
    accepts: isThenable,
  },
  onUserFollow: {
    invoke: (api) => api.onUserFollow((() => {}) as never),
    accepts: (value) => typeof value === "function",
  },
  onScrollChange: {
    invoke: (api) => api.onScrollChange((() => {}) as never),
    accepts: (value) => typeof value === "function",
  },
} satisfies Record<ExpectedApiMethod, ApiMethodProbe>;

export const verifyExports = (): string[] =>
  EXPECTED_EXPORTS.filter((name) => !(name in (pkg as Record<string, unknown>)));

export const verifyApiMethods = async (api: unknown): Promise<string[]> => {
  if (!api || typeof api !== "object") return [...EXPECTED_API_METHODS];
  const handle = api as Record<string, unknown>;
  const incompatible: string[] = [];

  for (const name of EXPECTED_API_METHODS) {
    const probe = API_METHOD_PROBES[name];
    const method = handle[name];
    if (typeof method !== "function") {
      incompatible.push(name);
      continue;
    }

    try {
      const result = probe.invoke(handle as Record<string, (...args: never[]) => unknown>);
      if (!probe.accepts(result)) {
        incompatible.push(name);
        continue;
      }
      if (name === "updateLibrary") await result;
      else if (typeof result === "function") result();
    } catch {
      incompatible.push(name);
    }
  }

  return incompatible;
};

export type InternalSelectorName = keyof typeof INTERNAL_SELECTORS;

export const verifySelectors = (
  container: HTMLElement | null,
  expected: readonly InternalSelectorName[] = Object.keys(
    INTERNAL_SELECTORS,
  ) as InternalSelectorName[],
): string[] => {
  if (!container) return [...expected];
  return expected
    .map((name) => [name, INTERNAL_SELECTORS[name]] as const)
    .filter(([, selector]) => !container.querySelector(selector))
    .map(([name]) => name);
};

/**
 * The whole surface at once.
 *
 * `missing` is a hard incompatibility -- something we call is gone. `changed`
 * is a selector that no longer matches: the editor still works, but a portal or
 * a chrome reading has lost its anchor and will degrade to its fallback.
 */
export const verifySeams = async (
  api: unknown,
  container: HTMLElement | null,
): Promise<SeamReport> => {
  const missingExports = verifyExports();
  const missingMethods = await verifyApiMethods(api);
  const changedSelectors = verifySelectors(container);
  return {
    checked:
      EXPECTED_EXPORTS.length +
      EXPECTED_API_METHODS.length +
      Object.keys(INTERNAL_SELECTORS).length,
    missing: [
      ...missingExports.map((name) => `export:${name}`),
      ...missingMethods.map((name) => `api:${name}`),
    ],
    changed: changedSelectors.map((name) => `selector:${name}`),
  };
};
