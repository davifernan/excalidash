import { useLayoutEffect, useRef, type ReactNode } from "react";
import { stacking } from "./stacking";

type Props = {
  elevated: boolean;
  children: ReactNode;
};

/**
 * Excalidraw renders embeddable content in a DOM sibling of its canvases. The
 * package gives every such sibling the same fixed layer, while the selected
 * element's frame moves to the SVG interaction layer. Keeping those two halves
 * together requires touching the package-owned wrapper, so that DOM knowledge
 * lives here at the adapter boundary instead of leaking into PDF/Markdown.
 */
export const ElementStackingBoundary = ({ elevated, children }: Props) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = contentRef.current?.closest<HTMLElement>(".excalidraw__embeddable-container");
    if (!container) return;
    const previous = container.style.zIndex;
    container.style.zIndex = elevated ? stacking.elementOverlay : stacking.elementContent;
    return () => {
      container.style.zIndex = previous;
    };
  }, [elevated]);

  return (
    <div ref={contentRef} data-excalidash-element-content style={{ width: "100%", height: "100%" }}>
      {children}
    </div>
  );
};
