import type React from "react";
import "./AgentPresenceOverlay.css";

export type BoardAgentHighlightBox = {
  key: string;
  targetId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  label: string | null;
  labelOffset: number;
  revisionId: string;
};

export const AgentPresenceOverlay: React.FC<{
  boxes: readonly BoardAgentHighlightBox[];
}> = ({ boxes }) => {
  if (boxes.length === 0) return null;
  return (
    <div className="agent-presence" data-testid="agent-presence" aria-live="polite">
      {boxes.map((box) => (
        <div
          key={box.key}
          className="agent-presence__highlight"
          data-testid="agent-presence-highlight"
          data-target-id={box.targetId}
          data-revision-id={box.revisionId}
          style={
            {
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              opacity: box.opacity,
              "--agent-presence-color": box.color,
            } as React.CSSProperties
          }
        >
          {box.label ? (
            <span
              className="agent-presence__label"
              style={{ transform: `translateY(${-box.labelOffset * 28}px)` }}
            >
              <span aria-hidden="true">◆</span> {box.label}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
};
