import { useCallback, useState } from "react";
import type { ExcalidrawAdapter } from "../../integrations/excalidraw/capabilities";
import { AgentRuntimePanel } from "./AgentRuntimePanel";

/**
 * Keeps the runtime panel on the public Excalidraw overlay seam. The menu
 * receives only open/toggle state; no panel markup is added to EditorView.
 */
export const useAgentRuntimeFeature = ({
  adapter,
  drawingId,
}: {
  adapter: ExcalidrawAdapter;
  drawingId?: string;
}) => {
  const [isAgentRuntimeOpen, setIsAgentRuntimeOpen] = useState(false);
  const toggleAgentRuntime = useCallback(() => setIsAgentRuntimeOpen((current) => !current), []);
  const root = adapter.ui.overlayRoot();
  return {
    isAgentRuntimeOpen,
    toggleAgentRuntime,
    agentRuntimeOverlay: root.ok ? (
      <AgentRuntimePanel
        container={root.value}
        drawingId={drawingId}
        open={isAgentRuntimeOpen}
        onClose={() => setIsAgentRuntimeOpen(false)}
      />
    ) : null,
  };
};
