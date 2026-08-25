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

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!target || !toolbar) {
      setPlacement(null);
      return;
    }

    const measure = () => {
      const hostRect = target.host.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const localAnchor = {
        left: target.anchor.left - hostRect.left,
        top: target.anchor.top - hostRect.top,
        right: target.anchor.right - hostRect.left,
        bottom: target.anchor.bottom - hostRect.top,
      };
      setPlacement(
        placeFloatingToolbar(
          localAnchor,
          { width: toolbarRect.width, height: toolbarRect.height },
          { width: hostRect.width, height: hostRect.height },
        ),
      );
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(target.host);
    observer?.observe(toolbar);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [target]);

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
