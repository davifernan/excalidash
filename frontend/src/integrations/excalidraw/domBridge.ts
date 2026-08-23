/**
 * The DOM bridge: every place this application reaches past the editor's public
 * surface and into the markup it renders.
 *
 * Nothing here is supported by Excalidraw. Class names, portal roots, the fact
 * that pressing Enter on a selected container opens its label -- all of it can
 * change in a patch release without anybody meaning to break us. Collected in
 * one file so an upgrade has one place to check rather than seven, and so every
 * one of them can report `editor-changed` when it stops working.
 *
 * Each function reports rather than throws, and each has a fallback the caller
 * can act on. A missing toolbar is not an error: it is the normal state in zen
 * mode and view mode, and the action belongs in the main menu instead.
 */

import { reportFailure } from "./compatibility/diagnostics";
import { fail, ok, type CapabilityFailure, type CapabilityResult } from "./errors";
import type { ChromeState } from "./capabilities";
import type { Unsubscribe } from "./types";
import { packageVersion } from "./version";

/**
 * The class names Excalidraw owns, in one list.
 *
 * Named here rather than inline so an upgrade can be checked against a single
 * table, and so `verifySeams` can report which of them stopped matching.
 */
export const INTERNAL_SELECTORS = {
  /** The editor's own root inside our container. Portal target for overlays. */
  root: ".excalidraw",
  /** The toolbar island. */
  toolbar: ".App-toolbar",
  /** The horizontal row inside the island. Appending to the island itself
   *  stacks vertically and puts our button on a second row. */
  toolbarRow: ".Stack_horizontal",
  /** Two signals, because the first is missing in view mode: there is no tool
   *  row there, but Alt+Z still works and an exit button appears instead. */
  zenMode: ".App-toolbar.zen-mode, .disable-zen-mode--visible",
  mobile: ".excalidraw--mobile",
  /** Chrome that should swallow a wheel event instead of zooming the canvas. */
  chrome: ".layer-ui__wrapper, .App-menu",
  /** The canvas that receives pointer input. Not the static one beneath it. */
  interactiveCanvas: "canvas.excalidraw__canvas.interactive",
} as const;

const report = <T>(result: CapabilityResult<T>): CapabilityResult<T> => {
  if (!result.ok) reportFailure(result as CapabilityFailure, packageVersion());
  return result;
};

/** The editor's own root element inside our container. */
export const findRoot = (container: HTMLElement | null): CapabilityResult<HTMLElement> => {
  if (!container) {
    return report(fail("not-ready", "domBridge.findRoot", { detail: "no container yet" }));
  }
  const root = container.querySelector<HTMLElement>(INTERNAL_SELECTORS.root);
  if (!root) {
    return report(
      fail("editor-changed", "domBridge.findRoot", {
        detail: `no element matching ${INTERNAL_SELECTORS.root}`,
      }),
    );
  }
  return ok(root);
};

/**
 * The row of tools, if there is one.
 *
 * Scoped to our container rather than searched for document-wide: two editors on
 * one page would otherwise both hang their button on the first one. Absence is
 * reported as `unsupported` with a main-menu fallback, because in zen and view
 * mode there genuinely is no toolbar and that is not a failure.
 */
export const findToolbarSlot = (container: HTMLElement | null): CapabilityResult<HTMLElement> => {
  if (!container) {
    return report(fail("not-ready", "domBridge.findToolbarSlot", { detail: "no container yet" }));
  }
  const island = container.querySelector<HTMLElement>(INTERNAL_SELECTORS.toolbar);
  if (!island) {
    return report(
      fail("unsupported", "domBridge.findToolbarSlot", {
        detail: "no toolbar in this layout",
        fallback: "main-menu",
      }),
    );
  }
  return ok(island.querySelector<HTMLElement>(INTERNAL_SELECTORS.toolbarRow) ?? island);
};

export const readChrome = (container: HTMLElement | null): ChromeState => ({
  zenMode: !!container?.querySelector(INTERNAL_SELECTORS.zenMode),
  mobile: !!container?.querySelector(INTERNAL_SELECTORS.mobile),
});

/** Is this event target part of the editor's own chrome rather than the canvas? */
export const isEditorChrome = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return INTERNAL_SELECTORS.chrome.split(", ").some((selector) => target.closest(selector));
};

/**
 * Watch the container for the editor rebuilding parts of itself.
 *
 * The toolbar is unmounted and rebuilt on entering zen mode or crossing the
 * mobile breakpoint, and anything anchored to it has to follow.
 */
export const observeStructure = (
  container: HTMLElement | null,
  onChange: () => void,
): Unsubscribe => {
  if (!container) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
};

/**
 * Ask the editor to start editing the selected container's label.
 *
 * There is no public way to do this. Excalidraw binds Enter on a selected valid
 * text container to opening its label editor, so this synthesises that key.
 *
 * `settled` is the part that matters. The old code sent the key and checked one
 * frame later whether the editor had opened -- but the editor opens through
 * React state, so the check ran before the state had committed and reported a
 * failure while the cursor was already blinking. It cried wolf so often that the
 * warning was removed, and with it the only way to notice when this genuinely
 * stops working. This waits for the real condition instead, with a deadline.
 */
export const pressEnterToEditLabel = async (
  container: HTMLElement | null,
  isEditing: () => boolean,
  options: { timeoutMs?: number } = {},
): Promise<CapabilityResult<void>> => {
  const rooted = findRoot(container);
  const target = rooted.ok ? rooted.value : container;
  if (!target) {
    return report(fail("not-ready", "domBridge.pressEnterToEditLabel"));
  }

  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );

  const deadline = options.timeoutMs ?? 1000;
  const startedAt = performance.now();
  while (performance.now() - startedAt < deadline) {
    if (isEditing()) return ok(undefined);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Reached only when the editor really did not open. The note is still there
  // and still selected, so Enter or a double click still works -- but somebody
  // should hear that the binding changed.
  return report(
    fail("editor-changed", "domBridge.pressEnterToEditLabel", {
      detail: "the editor did not begin editing within the deadline",
      fallback: "manual-selection",
    }),
  );
};

/**
 * The toolbar's outer box, for measuring against.
 *
 * Different from findToolbarSlot on purpose: that returns the row a button is
 * appended to, this returns the island a panel has to clear. Appending to the
 * island stacks vertically; measuring against the row leaves a panel overlapping
 * the island's lower edge.
 */
export const findToolbarIsland = (toolbar: HTMLElement | null): CapabilityResult<HTMLElement> => {
  if (!toolbar) {
    return report(fail("not-ready", "domBridge.findToolbarIsland", { detail: "no toolbar yet" }));
  }
  return ok(toolbar.closest<HTMLElement>(INTERNAL_SELECTORS.toolbar) ?? toolbar);
};

/**
 * Begin a drag on the editor's canvas at a point on screen.
 *
 * There is no public way to start a drag. Dragging an arrow out of a sticky note
 * arms the arrow tool and then synthesises the pointerdown the editor would have
 * received, on the interactive canvas -- the static one beneath it takes no
 * input.
 *
 * The frame between the two is not decoration: the tool is set through React
 * state, and a pointer event that lands before that commits is read as a
 * selection drag instead.
 */
export const beginCanvasDrag = async (
  container: HTMLElement | null,
  origin: {
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType?: string;
  },
): Promise<CapabilityResult<void>> => {
  const canvas = container?.querySelector<HTMLCanvasElement>(INTERNAL_SELECTORS.interactiveCanvas);
  if (!canvas) {
    return report(
      fail("editor-changed", "domBridge.beginCanvasDrag", {
        detail: `no element matching ${INTERNAL_SELECTORS.interactiveCanvas}`,
        fallback: "manual-selection",
      }),
    );
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: origin.clientX,
      clientY: origin.clientY,
      pointerId: origin.pointerId,
      pointerType: origin.pointerType || "mouse",
      button: 0,
      buttons: 1,
      isPrimary: true,
    }),
  );
  return ok(undefined);
};

/**
 * Turn a plain wheel over the canvas into the zoom gesture the editor listens
 * for.
 *
 * Excalidraw zooms on ctrl+wheel and pans on plain wheel, which is right for a
 * drawing tool and wrong for a board people scroll through. There is no prop for
 * it, so the plain wheel is cancelled and a ctrl+wheel synthesised in its place.
 *
 * The marker matters: the synthetic event goes to the same element and would
 * otherwise come straight back through this handler forever.
 */
const SYNTHETIC_ZOOM = "__excalidashSyntheticZoom";

export const isSyntheticZoom = (event: WheelEvent): boolean =>
  (event as unknown as Record<string, unknown>)[SYNTHETIC_ZOOM] === true;

export const dispatchZoomWheel = (target: HTMLElement, source: WheelEvent): void => {
  const zoomEvent = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: source.clientX,
    clientY: source.clientY,
    deltaX: source.deltaX,
    deltaY: source.deltaY,
    deltaMode: source.deltaMode,
    ctrlKey: true,
  });
  (zoomEvent as unknown as Record<string, unknown>)[SYNTHETIC_ZOOM] = true;
  target.dispatchEvent(zoomEvent);
};

/** Which internal selectors still match anything in this container. */
export const checkSelectors = (
  container: HTMLElement | null,
): { checked: number; missing: string[] } => {
  const entries = Object.entries(INTERNAL_SELECTORS);
  if (!container) return { checked: entries.length, missing: entries.map(([name]) => name) };
  const missing = entries
    .filter(([, selector]) => !container.querySelector(selector))
    .map(([name]) => name);
  return { checked: entries.length, missing };
};
