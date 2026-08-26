import type { CSSProperties } from "react";

/** Semantic roles backed by Excalidraw's CSS-variable scale in stacking.css. */
export const stacking = Object.freeze({
  canvas: "var(--excalidash-z-canvas)",
  elementContent: "var(--excalidash-z-element-content)",
  elementOverlay: "var(--excalidash-z-element-overlay)",
  chrome: "var(--excalidash-z-chrome)",
  backdrop: "var(--excalidash-z-backdrop)",
  preview: "var(--excalidash-z-preview)",
  anchoredOverlay: "var(--excalidash-z-anchored-overlay)",
  notificationContext: "var(--excalidash-z-notification-context)",
  widgetControls: "var(--excalidash-z-widget-controls)",
  modal: "var(--excalidash-z-modal)",
  popup: "var(--excalidash-z-popup)",
  notification: "var(--excalidash-z-notification)",
} as const);

/** A local reverse stack still names its base instead of inventing a scale. */
export const reverseElementStack = (index: number): CSSProperties => ({
  zIndex: `calc(${stacking.elementOverlay} - ${index})`,
});
