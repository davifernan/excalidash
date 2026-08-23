import React, { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import type {
  SceneCapability,
  ViewportCapability,
} from "../../../integrations/excalidraw/capabilities";
import type { ElementId } from "../../../integrations/excalidraw/types";
import type { Thread } from "./useComments";

type Props = {
  threads: Thread[];
  scene: SceneCapability;
  viewport: ViewportCapability;
  activeThreadId: string | null;
  onSelectThread: (rootId: string) => void;
};

type MarkerPosition = {
  threadId: string;
  left: number;
  top: number;
  resolved: boolean;
  count: number;
};

/**
 * Canvas pins.
 *
 * A thread anchored to a live element follows that element's current
 * position; a thread anchored to a bare point stays at the point it was
 * created at. A thread whose element was deleted or replaced shows no pin at
 * all -- it degrades to the panel/board context rather than pointing at
 * nothing (the anchor-survival decision from the package CLAIM). Recomputed
 * on every scroll/zoom and on every scene change, both throttled by rAF.
 */
export const CommentMarkers: React.FC<Props> = ({
  threads,
  scene,
  viewport,
  activeThreadId,
  onSelectThread,
}) => {
  const [positions, setPositions] = useState<MarkerPosition[]>([]);

  useEffect(() => {
    let raf: number | null = null;
    const recompute = () => {
      raf = null;
      const next: MarkerPosition[] = [];
      for (const { root, replies } of threads) {
        if (root.deletedAt) continue;
        let scenePoint: { x: number; y: number } | null = null;
        if (root.elementId) {
          const summary = scene.summaryById(root.elementId as ElementId);
          if (summary.ok && summary.value && !summary.value.isDeleted) {
            scenePoint = { x: summary.value.x, y: summary.value.y };
          }
          // Element gone: no pin for this thread (see module doc).
        } else if (root.anchorX !== null && root.anchorY !== null) {
          scenePoint = { x: root.anchorX, y: root.anchorY };
        }
        if (!scenePoint) continue;
        const projected = viewport.toViewport(scenePoint);
        if (!projected.ok) continue;
        next.push({
          threadId: root.id,
          left: projected.value.x,
          top: projected.value.y,
          resolved: Boolean(root.resolvedAt),
          count: 1 + replies.length,
        });
      }
      setPositions(next);
    };
    const schedule = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(recompute);
    };
    schedule();
    const unsubscribeScroll = viewport.subscribeScroll(schedule);
    const unsubscribeScene = scene.subscribe(schedule);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      unsubscribeScroll();
      unsubscribeScene();
    };
  }, [threads, scene, viewport]);

  return (
    <>
      {positions.map((position) => (
        <button
          key={position.threadId}
          type="button"
          onClick={() => onSelectThread(position.threadId)}
          data-testid="comment-marker"
          data-thread-id={position.threadId}
          title={position.resolved ? "Resolved thread" : "Open thread"}
          style={{
            position: "absolute",
            left: position.left,
            top: position.top,
            transform: "translate(-6px, -100%)",
            zIndex: position.threadId === activeThreadId ? 40 : 30,
          }}
          className="pointer-events-auto flex items-center gap-0.5 rounded-full rounded-bl-none border-2 border-black dark:border-neutral-700 px-1.5 py-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:scale-110"
        >
          <span
            className={
              position.resolved
                ? "flex items-center justify-center rounded-full bg-slate-300 dark:bg-neutral-700 text-slate-700 dark:text-neutral-200 w-5 h-5"
                : "flex items-center justify-center rounded-full bg-amber-400 text-black w-5 h-5"
            }
          >
            <MessageCircle size={12} strokeWidth={2.5} fill="currentColor" />
          </span>
          {position.count > 1 ? (
            <span className="text-[9px] font-black text-slate-700 dark:text-neutral-200 pr-0.5">
              {position.count}
            </span>
          ) : null}
        </button>
      ))}
    </>
  );
};
