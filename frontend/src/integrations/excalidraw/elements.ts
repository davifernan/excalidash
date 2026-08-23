/**
 * Element construction and history flags, behind local names.
 *
 * These are pure utilities from the package -- no editor instance involved --
 * so there is nothing to adapt, only to name. They still belong here rather
 * than being imported at seven call sites: an upgrade that renames one of them
 * should break one file, and `verifySeams` should be able to say which.
 *
 * The local names say what the caller wants rather than how the package spells
 * it. `CaptureUpdateAction.NEVER` is the editor's vocabulary; "this change is
 * not worth an undo step" is the product's.
 */

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";

/**
 * How a write is recorded in the undo history.
 *
 * NEVER is the one that matters: the sticky upkeep rewrites notes on every
 * change, and each of those would otherwise become a step somebody has to press
 * undo through to get back to their own last action.
 */
export const HISTORY = {
  immediate: CaptureUpdateAction.IMMEDIATELY,
  never: CaptureUpdateAction.NEVER,
  eventually: CaptureUpdateAction.EVENTUALLY,
} as const;

/**
 * Build full editor elements from skeletons.
 *
 * The package fills in every field an element needs beyond the few we set,
 * which is why this application does not construct elements by hand: a missing
 * field does not fail, it renders wrong somewhere else later.
 */
export const buildElements = (
  skeletons: readonly unknown[],
  options?: { regenerateIds?: boolean },
): Record<string, unknown>[] =>
  convertToExcalidrawElements(skeletons as never, options as never) as unknown as Record<
    string,
    unknown
  >[];

/**
 * A copy of an element with some fields changed.
 *
 * Not a spread: the package bumps the version bookkeeping that the
 * collaboration merge reconciles on. A hand-rolled `{...element, x}` looks
 * identical and loses the fact that anything changed.
 */
export const withChanges = <T>(element: T, changes: Record<string, unknown>): T =>
  newElementWith(element as never, changes as never) as unknown as T;

/**
 * Re-run the editor's own repair over elements.
 *
 * Used where this application has produced or resized elements and needs their
 * bound text laid out the way the editor would lay it out, rather than the way
 * we guess it would.
 */
export const restore = (
  elements: readonly unknown[],
  options?: { repairBindings?: boolean; refreshDimensions?: boolean },
): Record<string, unknown>[] =>
  restoreElements(elements as never, null, options as never) as unknown as Record<
    string,
    unknown
  >[];
