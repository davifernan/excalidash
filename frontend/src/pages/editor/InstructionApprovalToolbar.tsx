import { useEffect, useMemo, useState } from "react";
import { notify } from "../../notifications";
import {
  approveInstruction,
  getInstructionApproval,
  getInstructionContexts,
  previewInstructionApproval,
  type InstructionApprovalStatus,
  type InstructionContext,
} from "../../api/instructionApprovals";
import { ElementFloatingToolbar } from "./ElementFloatingToolbar";
import { elementViewportBounds } from "./floatingToolbarGeometry";
import { readViewport } from "../../integrations/excalidraw/viewport";
import {
  instructionCandidateForSelection,
  type InstructionSceneElement,
} from "./instructionApprovalSelection";

type Props = {
  drawingId?: string;
  canEdit: boolean;
  host: HTMLElement | null;
  elements: readonly InstructionSceneElement[];
  appState: { selectedElementIds?: Record<string, unknown> } | null;
  onOpenDispatch: () => void;
};

/**
 * Deliberately limited to the instruction-approval seam. This does not render
 * the broader Context Widget or start a run: dispatch remains a distinct,
 * explicit action in the runtime panel.
 */
export const InstructionApprovalToolbar = ({
  drawingId,
  canEdit,
  host,
  elements,
  appState,
  onOpenDispatch,
}: Props) => {
  const [contexts, setContexts] = useState<InstructionContext[]>([]);
  const [status, setStatus] = useState<InstructionApprovalStatus>("none");
  const [preview, setPreview] = useState<{ closureHash: string; canonical: string } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setContexts([]);
    if (!drawingId || !canEdit) return;
    void getInstructionContexts(drawingId)
      .then(setContexts)
      .catch(() => notify("error", "Anweisungskontext konnte nicht geladen werden."));
  }, [canEdit, drawingId]);

  const candidate = useMemo(
    () => instructionCandidateForSelection(elements, contexts, appState?.selectedElementIds),
    [appState?.selectedElementIds, contexts, elements],
  );
  const candidateKey = candidate
    ? `${candidate.contextId}:${candidate.element.id}:${candidate.element.originalText ?? candidate.element.text ?? ""}:${candidate.element.frameId ?? ""}`
    : null;
  const contextId = candidate?.contextId ?? null;
  const elementId = candidate?.element.id ?? null;

  useEffect(() => {
    setPreview(null);
    setStatus("none");
    if (!drawingId || !contextId || !elementId) return;
    void getInstructionApproval(drawingId, contextId, elementId)
      .then(({ status: nextStatus }) => setStatus(nextStatus))
      .catch(() => notify("error", "Freigabestatus konnte nicht geladen werden."));
  }, [candidateKey, contextId, drawingId, elementId]);

  if (!drawingId || !host || !candidate) return null;
  const target = {
    host,
    anchor: elementViewportBounds(candidate.element, readViewport(appState ?? {})),
  };

  const prepareApproval = async () => {
    setPending(true);
    try {
      const response = await previewInstructionApproval(
        drawingId,
        candidate.contextId,
        candidate.element.id,
      );
      setPreview(response.closure);
    } catch {
      notify("error", "Diese Fassung konnte nicht geprüft werden.");
    } finally {
      setPending(false);
    }
  };

  const confirmApproval = async () => {
    if (!preview) return;
    setPending(true);
    try {
      await approveInstruction(
        drawingId,
        candidate.contextId,
        candidate.element.id,
        preview.closureHash,
      );
      setStatus("approved");
      setPreview(null);
      notify("success", "Diese Fassung ist als Agent-Anweisung freigegeben.");
    } catch (error: any) {
      setPreview(null);
      if (error?.response?.data?.code === "APPROVAL_PREVIEW_STALE") {
        setStatus("expired");
        notify("info", "Die Vorschau ist veraltet. Prüfe die neue Fassung erneut.");
      } else {
        notify("error", "Die Anweisung konnte nicht freigegeben werden.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <ElementFloatingToolbar target={target} label="Agent-Anweisung" compactWhenCrowded>
      <div className="instruction-approval-toolbar__row">
        {preview ? (
          <>
            <span className="instruction-approval-toolbar__preview" title={preview.closureHash}>
              Geprüfte Fassung · {preview.closureHash.slice(0, 12)}
            </span>
            <button type="button" disabled={pending} onClick={() => void confirmApproval()}>
              Diese Fassung freigeben
            </button>
            <button type="button" disabled={pending} onClick={() => setPreview(null)}>
              Abbrechen
            </button>
          </>
        ) : status === "approved" ? (
          <>
            <span className="instruction-approval-toolbar__status">Anweisung · freigegeben</span>
            <span className="instruction-approval-toolbar__divider" aria-hidden="true" />
            <button type="button" onClick={onOpenDispatch}>
              Agent-Dispatch öffnen
            </button>
          </>
        ) : (
          <>
            <span className="instruction-approval-toolbar__status">
              {status === "expired" ? "Freigabe verfallen" : "Noch nicht freigegeben"}
            </span>
            <button type="button" disabled={pending} onClick={() => void prepareApproval()}>
              {status === "expired" ? "Neue Fassung prüfen" : "Als Agent-Anweisung freigeben"}
            </button>
          </>
        )}
      </div>
    </ElementFloatingToolbar>
  );
};
