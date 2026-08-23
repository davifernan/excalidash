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

export const verifyExports = (): string[] =>
  EXPECTED_EXPORTS.filter((name) => !(name in (pkg as Record<string, unknown>)));

export const verifyApiMethods = (api: unknown): string[] => {
  if (!api || typeof api !== "object") return [...EXPECTED_API_METHODS];
  const handle = api as Record<string, unknown>;
  return EXPECTED_API_METHODS.filter((name) => typeof handle[name] !== "function");
};

export const verifySelectors = (container: HTMLElement | null): string[] => {
  if (!container) return Object.keys(INTERNAL_SELECTORS);
  return Object.entries(INTERNAL_SELECTORS)
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
export const verifySeams = (api: unknown, container: HTMLElement | null): SeamReport => {
  const missingExports = verifyExports();
  const missingMethods = verifyApiMethods(api);
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
