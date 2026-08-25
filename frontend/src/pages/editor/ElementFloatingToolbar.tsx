import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  placeFloatingToolbar,
  type FloatingToolbarTarget,
  type ToolbarPlacement,
} from "./floatingToolbarGeometry";
import {
  findFloatingToolbarObstacleElements,
  observeStructure,
} from "../../integrations/excalidraw/domBridge";
import "./ElementFloatingToolbar.css";

type Props = {
  target: FloatingToolbarTarget | null;
  label: string;
  children: ReactNode;
  compactWhenCrowded?: boolean;
};

export const ElementFloatingToolbar = ({
  target,
  label,
  children,
  compactWhenCrowded = false,
}: Props) => {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const regularSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [placement, setPlacement] = useState<ToolbarPlacement | null>(null);
  const [compact, setCompact] = useState(false);

  const host = target?.host ?? null;
  const anchorLeft = target?.anchor.left ?? null;
  const anchorTop = target?.anchor.top ?? null;
  const anchorRight = target?.anchor.right ?? null;
  const anchorBottom = target?.anchor.bottom ?? null;

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (
      !host ||
      !toolbar ||
      anchorLeft === null ||
      anchorTop === null ||
      anchorRight === null ||
      anchorBottom === null
    ) {
      setPlacement(null);
      return;
    }

    const measure = () => {
      const hostRect = host.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const obstacleElements = findFloatingToolbarObstacleElements(host);
      const measuredSize = { width: toolbarRect.width, height: toolbarRect.height };
      if (!compact) regularSizeRef.current = measuredSize;
      const regularSize = regularSizeRef.current ?? measuredSize;
      const localAnchor = {
        left: anchorLeft - hostRect.left,
        top: anchorTop - hostRect.top,
        right: anchorRight - hostRect.left,
        bottom: anchorBottom - hostRect.top,
      };
      const obstacles = obstacleElements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left - hostRect.left,
          top: rect.top - hostRect.top,
          right: rect.right - hostRect.left,
          bottom: rect.bottom - hostRect.top,
        };
      });
      const regularPlacement = placeFloatingToolbar(
        localAnchor,
        regularSize,
        { width: hostRect.width, height: hostRect.height },
        obstacles,
      );
      const shouldCompact = compactWhenCrowded && regularPlacement.side === "inside";
      setCompact(shouldCompact);
      const next =
        shouldCompact && compact
          ? placeFloatingToolbar(
              localAnchor,
              measuredSize,
              { width: hostRect.width, height: hostRect.height },
              obstacles,
            )
          : regularPlacement;
      setPlacement((current) =>
        current?.left === next.left && current.top === next.top && current.side === next.side
          ? current
          : next,
      );
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(host);
    observer?.observe(toolbar);
    findFloatingToolbarObstacleElements(host).forEach((element) => observer?.observe(element));
    const stopObservingStructure = observeStructure(host, measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      stopObservingStructure();
      window.removeEventListener("resize", measure);
    };
  }, [anchorBottom, anchorLeft, anchorRight, anchorTop, compact, compactWhenCrowded, host]);

  if (!target) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={label}
      data-floating-element-toolbar
      data-placement={placement?.side}
      data-layout={compact ? "compact" : "regular"}
      className="element-floating-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: placement ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    target.host,
  );
};
