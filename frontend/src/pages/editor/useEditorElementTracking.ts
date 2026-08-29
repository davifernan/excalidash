import { useCallback, useRef } from "react";
import { elementContentSignature } from "../../utils/sync";
import type { ElementVersionInfo } from "./shared";

export const computeElementOrderSig = (elements: readonly any[]) => {
  let hash = 2166136261;
  let count = 0;
  for (const el of elements) {
    if (el?.isDeleted) continue;
    const id = typeof el?.id === "string" ? el.id : "";
    if (!id) continue;
    count += 1;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 124;
    hash = Math.imul(hash, 16777619);
  }
  return `${count}:${(hash >>> 0).toString(16)}`;
};

/**
 * Read the four tracked fields off a live element right now. A caller that
 * will only use the result synchronously (recording state right after
 * reading it, or right after `scene.apply()`/hydration handed back a final
 * element) can pass the element straight to `recordElementVersion` instead.
 *
 * A caller that hands this element to something asynchronous first --
 * queuing it for a network round trip and only recording once that round
 * trip acknowledges -- must call this *before* the async gap and keep the
 * result, not re-derive it from the element inside the ack callback. Excalidraw
 * owns these element objects and mutates them in place; nothing prevents its
 * own next action (binding a label to a container, for instance) from
 * mutating the very same object while our packet is in flight. Reading the
 * live element again at ack time then records a state that was never
 * actually sent, so the real change that state already reflects looks
 * "already synced" and is never rebroadcast (NIL-689).
 */
export const captureElementVersionInfo = (element: any): ElementVersionInfo => ({
  version: element.version ?? 0,
  versionNonce: element.versionNonce ?? 0,
  updated: typeof element?.updated === "number" ? element.updated : Number(element?.updated) || 0,
  contentSig: elementContentSignature(element),
});

export const useEditorElementTracking = () => {
  const elementVersionMap = useRef<Map<string, ElementVersionInfo>>(new Map());

  const recordElementVersionInfo = useCallback((id: string, info: ElementVersionInfo) => {
    elementVersionMap.current.set(id, info);
  }, []);

  const recordElementVersion = useCallback(
    (element: any) => recordElementVersionInfo(element.id, captureElementVersionInfo(element)),
    [recordElementVersionInfo],
  );

  const hasElementChanged = useCallback((element: any) => {
    const previous = elementVersionMap.current.get(element.id);
    if (!previous) return true;
    const next = captureElementVersionInfo(element);
    return (
      previous.version !== next.version ||
      previous.versionNonce !== next.versionNonce ||
      previous.updated !== next.updated ||
      previous.contentSig !== next.contentSig
    );
  }, []);

  return {
    computeElementOrderSig,
    elementVersionMap,
    hasElementChanged,
    recordElementVersion,
    recordElementVersionInfo,
  };
};
