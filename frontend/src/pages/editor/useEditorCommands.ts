import { useCallback, useEffect } from "react";
import type { FormEvent, MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import * as api from "../../api";
import { exportFromEditor } from "../../utils/exportUtils";
import type {
  BoardSettingsCapability,
  FileCapability,
} from "../../integrations/excalidraw/capabilities";
import { hasRenderableElements } from "./shared";
import { log } from "../../logging";

const capabilityError = (failure: { seam: string; code: string }) =>
  new Error(`${failure.seam} failed (${failure.code})`);

type EditorCommandRefs = {
  excalidrawAPI: MutableRefObject<any>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  saveData: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => Promise<void>)
    | null
  >;
  savePreview: MutableRefObject<
    | ((drawingId: string, elements: readonly any[], appState: any, files: any) => Promise<void>)
    | null
  >;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorCommandsParams = {
  boardSettings: BoardSettingsCapability;
  canEdit: boolean;
  debouncedSaveLibrary: (items: any[]) => void;
  drawingId: string | undefined;
  drawingName: string;
  files: FileCapability;
  isSavingOnLeave: boolean;
  newName: string;
  refs: EditorCommandRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    snapshot: readonly any[];
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
  enqueueSceneSave: (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
    options?: { suppressErrors?: boolean },
  ) => Promise<void>;
  setDrawingName: (name: string) => void;
  setIsRenaming: (isRenaming: boolean) => void;
  setIsSavingOnLeave: (isSaving: boolean) => void;
  setNewName: (name: string) => void;
  user: unknown;
};

export const useEditorCommands = ({
  boardSettings,
  canEdit,
  debouncedSaveLibrary,
  drawingId,
  drawingName,
  enqueueSceneSave,
  files,
  isSavingOnLeave,
  newName,
  refs,
  resolveSafeSnapshot,
  setDrawingName,
  setIsRenaming,
  setIsSavingOnLeave,
  setNewName,
  user,
}: UseEditorCommandsParams) => {
  const navigate = useNavigate();

  const readFiles = useCallback(() => {
    const result = files.read();
    if (!result.ok) throw capabilityError(result);
    return result.value;
  }, [files]);

  const readBoardSettings = useCallback(() => {
    const result = boardSettings.read();
    if (!result.ok) throw capabilityError(result);
    return result.value;
  }, [boardSettings]);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (!canEdit) return;
        if (!(refs.excalidrawAPI.current && refs.saveData.current && refs.savePreview.current)) {
          return;
        }
        if (!drawingId) return;
        const elements = refs.latestElements.current;
        const { snapshot: safeElements } = resolveSafeSnapshot(elements);
        const appState = readBoardSettings();
        const files = readFiles();
        refs.latestFiles.current = files;
        await enqueueSceneSave(drawingId, safeElements, appState, files);
        refs.savePreview.current(drawingId, safeElements, appState, files);
        toast.success("Saved changes to server");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    canEdit,
    drawingId,
    enqueueSceneSave,
    readBoardSettings,
    readFiles,
    refs,
    resolveSafeSnapshot,
  ]);

  const handleRenameSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canEdit) return;
      if (newName.trim() && drawingId) {
        setDrawingName(newName);
        setIsRenaming(false);
        try {
          await api.updateDrawing(drawingId, { name: newName });
        } catch (err) {
          // notify: default -- setDrawingName above already updated the
          // visible name optimistically; with no rollback and no other
          // signal, a failed rename otherwise looks like it succeeded.
          log.error("Failed to rename", { error: err });
        }
      }
    },
    [canEdit, drawingId, newName, setDrawingName, setIsRenaming],
  );

  const handleLibraryChange = useCallback(
    (items: readonly any[]) => {
      if (!canEdit || !user) return;
      debouncedSaveLibrary([...items]);
    },
    [canEdit, debouncedSaveLibrary, user],
  );

  const handleBackClick = useCallback(async () => {
    if (isSavingOnLeave) return;
    setIsSavingOnLeave(true);
    let shouldNavigate = false;
    try {
      if (!(refs.excalidrawAPI.current && refs.saveData.current && refs.savePreview.current)) {
        shouldNavigate = true;
      } else if (!canEdit || !refs.hasSceneChangesSinceLoad.current) {
        shouldNavigate = true;
      } else if (!drawingId) {
        shouldNavigate = true;
      } else {
        const elements = refs.latestElements.current;
        const { snapshot: safeElements } = resolveSafeSnapshot(elements);
        const appState = readBoardSettings();
        const files = readFiles();
        refs.latestFiles.current = files;
        if (refs.suspiciousBlankLoad.current && !hasRenderableElements(safeElements)) {
          toast.warning("Blank scene detected on load. Skipping save to protect existing data.");
          shouldNavigate = true;
        } else {
          await Promise.all([
            enqueueSceneSave(drawingId, safeElements, appState, files, {
              suppressErrors: false,
            }),
            refs.savePreview.current(drawingId, safeElements, appState, files),
          ]);
          shouldNavigate = true;
        }
      }
    } catch (err) {
      log.error("Failed to save on back navigation", { error: err }, { notify: false });
      toast.error("Failed to save changes. Please retry before leaving.");
    } finally {
      setIsSavingOnLeave(false);
    }
    if (shouldNavigate) navigate("/collections");
  }, [
    canEdit,
    drawingId,
    enqueueSceneSave,
    isSavingOnLeave,
    navigate,
    readBoardSettings,
    readFiles,
    refs,
    resolveSafeSnapshot,
    setIsSavingOnLeave,
  ]);

  const handleExportClick = useCallback(async () => {
    if (!drawingId || !refs.excalidrawAPI.current) return;
    try {
      const elements = refs.latestElements.current;
      const appState = readBoardSettings();
      const files = readFiles();
      await exportFromEditor(drawingId, drawingName, elements, appState, files);
      toast.success("Drawing exported");
    } catch (error) {
      console.error("Failed to export drawing", error);
      toast.error("Export cancelled because one or more drawing images could not be bundled.");
    }
  }, [drawingId, drawingName, readBoardSettings, readFiles, refs]);

  const handleRenameStart = useCallback(() => {
    if (!canEdit) return;
    setNewName(drawingName);
    setIsRenaming(true);
  }, [canEdit, drawingName, setIsRenaming, setNewName]);

  return {
    handleBackClick,
    handleExportClick,
    handleLibraryChange,
    handleRenameStart,
    handleRenameSubmit,
  };
};
