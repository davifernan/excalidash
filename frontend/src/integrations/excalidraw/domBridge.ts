const OUTER_LASER_SELECTOR = '[data-testid="toolbar-LaserPointer"]';
const EXTRA_TOOLS_LASER_SELECTOR = '[data-testid="toolbar-laser"]';
const LASER_SHORTCUT_LABEL = "Laser pointer — K";

const reconcileLaserPointerControls = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>(EXTRA_TOOLS_LASER_SELECTOR).forEach((control) => {
    control.hidden = true;
    // Excalidraw's button class sets `display: flex`, which overrides the
    // browser's default `[hidden]` rule. Keep the semantic flag and enforce the
    // visual removal at this compatibility boundary.
    control.style.display = "none";
  });

  root.querySelectorAll<HTMLInputElement>(OUTER_LASER_SELECTOR).forEach((control) => {
    control.setAttribute("aria-label", LASER_SHORTCUT_LABEL);
    control.setAttribute("aria-keyshortcuts", "K");
    control.closest("label")?.setAttribute("title", LASER_SHORTCUT_LABEL);
  });
};

/**
 * Normalizes the laser controls rendered by the pinned Excalidraw package.
 *
 * Excalidraw 0.18 renders its collaboration laser both beside the toolbar and
 * inside the extra-tools menu, and its outer control omits the K shortcut from
 * the accessible label. Neither behavior is configurable through its public
 * UIOptions contract, so this fragile DOM dependency stays isolated here.
 */
export const installLaserPointerDomBridge = (root: HTMLElement): (() => void) => {
  reconcileLaserPointerControls(root);
  const observer = new MutationObserver(() => reconcileLaserPointerControls(root));
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
};
