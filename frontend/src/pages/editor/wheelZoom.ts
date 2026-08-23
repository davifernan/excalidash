import {
  dispatchZoomWheel,
  isEditorChrome,
  isSyntheticZoom,
} from "../../integrations/excalidraw/domBridge";

export const bindCanvasWheelZoom = (container: HTMLDivElement | null) => {
  const handleWheel = (event: WheelEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const isCanvas = target.tagName?.toLowerCase() === "canvas";
    if (
      !isCanvas ||
      isEditorChrome(target) ||
      event.ctrlKey ||
      event.metaKey ||
      isSyntheticZoom(event)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dispatchZoomWheel(target, event);
  };
  container?.addEventListener("wheel", handleWheel, {
    capture: true,
    passive: false,
  });
  return () => container?.removeEventListener("wheel", handleWheel, { capture: true });
};
