import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  placeFloatingToolbar,
  type FloatingToolbarTarget,
  type ToolbarPlacement,
} from "./floatingToolbarGeometry";
import "./ElementFloatingToolbar.css";

type Props = {
  target: FloatingToolbarTarget | null;
  label: string;
  children: ReactNode;
};

export const ElementFloatingToolbar = ({ target, label, children }: Props) => {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ToolbarPlacement | null>(null);

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
      const localAnchor = {
        left: anchorLeft - hostRect.left,
        top: anchorTop - hostRect.top,
        right: anchorRight - hostRect.left,
        bottom: anchorBottom - hostRect.top,
      };
      const next = placeFloatingToolbar(
        localAnchor,
        { width: toolbarRect.width, height: toolbarRect.height },
        { width: hostRect.width, height: hostRect.height },
      );
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
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchorBottom, anchorLeft, anchorRight, anchorTop, host]);

  if (!target) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={label}
      data-floating-element-toolbar
      data-placement={placement?.side}
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
