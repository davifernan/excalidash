/**
 * React access to the optional toolbar mount exposed by the local UI
 * capability. The editor rebuilds this DOM when its layout changes, so portal
 * consumers subscribe to structure instead of caching the first element.
 */
import { useEffect, useState } from "react";
import type React from "react";
import { findToolbarSlot, observeStructure } from "./domBridge";

export const useToolbarSlot = (containerRef: React.RefObject<HTMLElement>): HTMLElement | null => {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const find = () => {
      const result = findToolbarSlot(container);
      const found = result.ok ? result.value : null;
      setToolbar((current) => (current === found ? current : found));
    };

    find();
    return observeStructure(container, find);
  }, [containerRef]);

  return toolbar;
};
