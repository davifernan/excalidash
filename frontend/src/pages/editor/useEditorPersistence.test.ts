import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { compressExcalidrawFiles } from "../../utils/imageCompression";
import { getFilesDelta } from "./shared";
import { useEditorPersistence } from "./useEditorPersistence";
import { canonicalizeStickyFontState } from "../../sticky/stickyDerivedState";
import { createStickyNote } from "../../sticky/stickyNote";

const { notification } = vi.hoisted(() => ({ notification: vi.fn() }));

vi.mock("../../api", () => ({
  getDrawing: vi.fn(),
  updateDrawing: vi.fn(),
  updateLibrary: vi.fn(),
  isAxiosError: vi.fn().mockReturnValue(false),
}));

vi.mock("../../utils/imageCompression", () => ({
  compressExcalidrawFiles: vi.fn(),
}));

vi.mock("../../notifications", () => ({ notify: notification }));

vi.mock("@excalidraw/excalidraw", () => ({
  // integrations/excalidraw/elements imports the whole utility surface, so a
  // partial mock leaves that module unloadable rather than merely thin.
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER", EVENTUALLY: "EVENTUALLY" },
  convertToExcalidrawElements: (elements: any[]) => elements,
  newElementWith: (element: any, changes: any) => ({ ...element, ...changes }),
  restoreElements: (elements: any[]) => elements,
  exportToSvg: vi.fn(),
}));

const ref = <T>(current: T) => ({ current });

const createRefs = (files: Record<string, any>, lastSyncedFiles: Record<string, any> = {}) => ({
  currentDrawingVersion: ref<number | null>(1),
  debouncedSave: ref<any>(null),
  excalidrawAPI: ref({
    addFiles: vi.fn(),
    getAppState: vi.fn().mockReturnValue(null),
    updateScene: vi.fn(),
  }),
  isSyncing: ref(false),
  isUnmounting: ref(false),
  lastLocalChangeAt: ref(0),
  lastPersistedElements: ref<readonly any[]>([]),
  lastPersistedFiles: ref<Record<string, any>>({}),
  lastSyncedFiles: ref(lastSyncedFiles),
  latestAppState: ref<any>(null),
  latestElements: ref<readonly any[]>([]),
  latestFiles: ref<any>(files),
  saveQueue: ref(Promise.resolve()),
  suspiciousBlankLoad: ref(false),
});

const okv = <T>(value: T) => ({ ok: true as const, value });

const fakeScene = () =>
  ({
    apply: vi.fn(() => okv(undefined)),
    applySettled: vi.fn(async () => okv(undefined)),
    readDocument: vi.fn(() => okv({ elements: [], appState: {}, files: {} })),
    summaries: vi.fn(() => okv([])),
    summaryById: vi.fn(() => okv(null)),
    subscribe: vi.fn(() => () => {}),
    toPersisted: vi.fn(() => okv({ elements: [], appState: {}, files: {} })),
    fromPersisted: vi.fn(() => okv({ elements: [], appState: {}, files: {} })),
    rebaseOntoServer: vi.fn(() => okv({ elements: [], appState: {}, files: {} })),
    relayout: vi.fn(() => okv({ elements: [], appState: {}, files: {} })),
  }) as any;

const fakeFiles = () => ({ add: vi.fn(() => okv(undefined)), read: vi.fn(() => okv({})) }) as any;

/** Nothing is being held: the rebase then protects nothing, which is the safe side. */
const fakeInteraction = () =>
  ({
    read: vi.fn(() =>
      okv({
        editingTextElementId: null,
        editingTextContainerId: null,
        creatingElementId: null,
        resizingElementId: null,
        activeTool: { type: "selection" },
      }),
    ),
    subscribe: vi.fn(() => () => {}),
    setActiveTool: vi.fn(() => okv(undefined)),
    setActiveToolSettled: vi.fn(async () => okv(undefined)),
    onPointerDown: vi.fn(() => () => {}),
  }) as any;

const capabilitySet = () => ({
  scene: fakeScene(),
  fileCapability: fakeFiles(),
  interaction: fakeInteraction(),
});

const renderPersistence = (
  refs: ReturnType<typeof createRefs>,
  capabilities = capabilitySet(),
  normalizeImageElementStatus: (elements: readonly any[]) => readonly any[] = (elements) =>
    elements || [],
) =>
  renderHook(() =>
    useEditorPersistence({
      refs,
      // Capabilities, not the handle. The hook no longer probes the editor
      // itself; a `not-ready` answer is the capability's job to give.
      scene: capabilities.scene,
      fileCapability: capabilities.fileCapability,
      interaction: capabilities.interaction,
      user: null,
      normalizeImageElementStatus,
      resolveSafeSnapshot: (elements) => ({
        snapshot: elements || [],
        prevented: false,
        staleEmptySnapshot: false,
        staleNonRenderableSnapshot: false,
      }),
    }),
  );

describe("useEditorPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.isAxiosError).mockReturnValue(false);
  });

  it("loads and merges the server scene before saving when its version is unknown", async () => {
    const localElement = { id: "local", type: "rectangle", version: 1 };
    const serverElement = { id: "server", type: "ellipse", version: 1 };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: {},
      changed: false,
      changedIds: [],
    });
    vi.mocked(api.getDrawing).mockResolvedValue({
      version: 7,
      elements: [serverElement],
      files: {},
    } as any);
    vi.mocked(api.updateDrawing).mockResolvedValue({ version: 8 } as any);
    const refs = createRefs({});
    refs.currentDrawingVersion.current = null;
    const { result } = renderPersistence(refs);

    await act(async () => {
      await result.current.saveDataRef.current?.("drawing", [localElement], {}, {});
    });

    expect(api.getDrawing).toHaveBeenCalledWith("drawing");
    expect(api.updateDrawing).toHaveBeenCalledTimes(1);
    expect(api.updateDrawing).toHaveBeenCalledWith(
      "drawing",
      expect.objectContaining({
        elements: [localElement, serverElement],
        version: 7,
      }),
    );
    expect(refs.latestElements.current).toEqual([localElement, serverElement]);
    expect(refs.currentDrawingVersion.current).toBe(8);
  });

  it("keeps a failed save visible to the next file delta", async () => {
    const previouslySyncedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,previous" },
    };
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,unsaved" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.updateDrawing).mockRejectedValueOnce(new Error("save rejected"));
    const refs = createRefs(editorFiles, previouslySyncedFiles);
    const { result } = renderPersistence(refs);

    await act(async () => {
      await expect(
        result.current.saveDataRef.current?.(
          "drawing",
          [{ id: "element", type: "image", fileId: "image" }],
          {},
          editorFiles,
        ),
      ).rejects.toThrow("save rejected");
    });

    expect(refs.lastSyncedFiles.current).toBe(previouslySyncedFiles);
    expect(getFilesDelta(refs.lastSyncedFiles.current, editorFiles)).toEqual({
      image: editorFiles.image,
    });
    expect(notification).toHaveBeenCalledWith(
      "error",
      "Changes could not be saved. Your work is still open.",
      expect.objectContaining({ detail: expect.stringContaining("Retry before reloading") }),
    );
  });

  it("drains a queued scene snapshot before an asset replacement can begin", async () => {
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: {},
      changed: false,
      changedIds: [],
    });
    vi.mocked(api.updateDrawing).mockResolvedValue({ version: 2 } as any);
    const refs = createRefs({});
    const { result } = renderPersistence(refs);

    act(() => {
      result.current.debouncedSave("drawing", [{ id: "widget", type: "embeddable" }], {}, {});
    });
    await act(async () => {
      await result.current.flushPendingSceneSave();
    });

    expect(api.updateDrawing).toHaveBeenCalledWith(
      "drawing",
      expect.objectContaining({ elements: [{ id: "widget", type: "embeddable" }] }),
    );
  });

  it("makes a guest-upload rejection explicit while leaving the editor state open", async () => {
    const rejection = {
      response: { status: 403, data: { code: "GUEST_UPLOAD_DISABLED" } },
    };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: {},
      changed: false,
      changedIds: [],
    });
    vi.mocked(api.isAxiosError).mockImplementation((error) => error === rejection);
    vi.mocked(api.updateDrawing).mockRejectedValueOnce(rejection);
    const refs = createRefs({});
    const { result } = renderPersistence(refs);

    await act(async () => {
      await expect(
        result.current.saveDataRef.current?.(
          "drawing",
          [{ id: "unsaved-text", type: "text", text: "Keep this text" }],
          {},
          {},
        ),
      ).rejects.toBe(rejection);
    });

    expect(refs.lastPersistedElements.current).toEqual([]);
    expect(notification).toHaveBeenCalledWith(
      "error",
      "Changes were not saved because this board does not allow guest uploads.",
      expect.objectContaining({ detail: expect.stringContaining("Your changes are still open") }),
    );
  });

  it("does not compress or persist files whose image was deleted", async () => {
    const live = { id: "live", dataURL: "data:image/png;base64,live" };
    const orphaned = { id: "orphaned", dataURL: "data:image/png;base64,large" };
    const editorFiles = { live, orphaned };
    vi.mocked(compressExcalidrawFiles).mockImplementation(async (files) => ({
      files,
      changed: false,
      changedIds: [],
    }));
    vi.mocked(api.updateDrawing).mockResolvedValue({ version: 2 } as any);
    const refs = createRefs(editorFiles);
    refs.lastPersistedFiles.current = editorFiles;
    const { result } = renderPersistence(refs);

    await act(async () => {
      await result.current.saveDataRef.current?.(
        "drawing",
        [
          { id: "live-element", type: "image", fileId: "live", isDeleted: false },
          { id: "deleted-element", type: "image", fileId: "orphaned", isDeleted: true },
        ],
        {},
        editorFiles,
      );
    });

    expect(compressExcalidrawFiles).toHaveBeenCalledWith({ live });
    expect(api.updateDrawing).toHaveBeenCalledWith(
      "drawing",
      expect.objectContaining({ files: { live } }),
    );
    expect(refs.lastPersistedFiles.current).toEqual({ live });
  });

  it("does not book the baseline after the bounded conflict retry fails", async () => {
    const previouslySyncedFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,previous" },
    };
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,unsaved" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    const conflict = { response: { status: 409 } };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.isAxiosError).mockImplementation((error) => error === conflict);
    vi.mocked(api.updateDrawing).mockRejectedValue(conflict);
    vi.mocked(api.getDrawing).mockResolvedValue({
      version: 2,
      elements: [],
      files: {},
    } as any);
    const refs = createRefs(editorFiles, previouslySyncedFiles);
    const { result } = renderPersistence(refs);

    await act(async () => {
      await expect(
        result.current.saveDataRef.current?.(
          "drawing",
          [{ id: "element", type: "image", fileId: "image" }],
          {},
          editorFiles,
        ),
      ).rejects.toThrow("Drawing version conflict");
    });

    expect(api.getDrawing).toHaveBeenCalledTimes(1);
    expect(api.updateDrawing).toHaveBeenCalledTimes(2);
    expect(refs.lastSyncedFiles.current).toBe(previouslySyncedFiles);
  });

  it("keeps the editor file map as the sync baseline after compression", async () => {
    const editorFiles = {
      image: { id: "image", dataURL: "data:image/png;base64,original" },
    };
    const compressedFiles = {
      image: { id: "image", dataURL: "data:image/webp;base64,compressed" },
    };
    vi.mocked(compressExcalidrawFiles).mockResolvedValue({
      files: compressedFiles,
      changed: true,
      changedIds: ["image"],
    });
    vi.mocked(api.updateDrawing).mockResolvedValue({
      version: 2,
      files: compressedFiles,
    } as any);

    const refs = createRefs(editorFiles);
    const capabilities = capabilitySet();
    const { result } = renderPersistence(refs, capabilities);

    await act(async () => {
      await result.current.saveDataRef.current?.(
        "drawing",
        [{ id: "element", type: "image", fileId: "image" }],
        {},
        editorFiles,
      );
    });

    expect(api.updateDrawing).toHaveBeenCalledWith(
      "drawing",
      expect.objectContaining({ files: compressedFiles }),
    );
    // Through the capability now, not the handle: the hook hands the compressed
    // files to the boundary and lets it answer.
    expect(capabilities.fileCapability.add).toHaveBeenCalledWith(Object.values(compressedFiles));
    expect(refs.latestFiles.current).toBe(compressedFiles);
    expect(refs.lastPersistedFiles.current).toBe(compressedFiles);
    expect(refs.lastSyncedFiles.current).toBe(editorFiles);
    expect(getFilesDelta(refs.lastSyncedFiles.current, editorFiles)).toEqual({});
  });

  describe("rebaseOntoLatest and NIL-690's echo (measured, not assumed)", () => {
    // NIL-690 asks that a content-identical remote OR persistence echo never
    // bump an unchanged element's bookkeeping. The remote-flush path
    // (useEditorCollaboration.ts) is fixed there; this hook has its own,
    // separate reconcileElements call (rebaseOntoLatest, used whenever the
    // local version base is unknown -- exactly this first-save-after-load
    // case). Does an untouched Sticky label reach IT with a derived-vs-
    // canonical signature mismatch too? Measured directly with the REAL
    // canonicalizeStickyFontState as this hook's `normalizeImageElementStatus`
    // (production wires the identical function in via Editor.tsx's
    // `normalizeSceneForTransport`), not a no-op test stub.
    it("an untouched sticky label reaches the rebase merge already-canonical on both sides -- no echo is possible here", async () => {
      const note = createStickyNote(100, 100);
      note.boundElements = [{ id: "sticky-label", type: "text" }];
      const derivedLabel = {
        id: "sticky-label",
        type: "text",
        containerId: note.id,
        fontSize: 9.48519094968704, // the locally *derived* size the user sees
        version: 7,
        versionNonce: 11,
        updated: 13,
      };
      // The server's stored copy of the SAME, unedited label: always
      // canonical, because every save already ran it through this same
      // function before it ever reached the network (Editor.tsx's
      // normalizeSceneForTransport). Identical bookkeeping -- nothing
      // changed it server-side either.
      const serverLabel = { ...derivedLabel, fontSize: 20 };

      vi.mocked(compressExcalidrawFiles).mockResolvedValue({
        files: {},
        changed: false,
        changedIds: [],
      });
      vi.mocked(api.getDrawing).mockResolvedValue({
        version: 7,
        elements: [note, serverLabel],
        files: {},
      } as any);
      vi.mocked(api.updateDrawing).mockResolvedValue({ version: 8 } as any);
      const refs = createRefs({});
      refs.currentDrawingVersion.current = null; // forces rebaseOntoLatest
      const { result } = renderPersistence(refs, capabilitySet(), canonicalizeStickyFontState);

      await act(async () => {
        // The live scene still holds the locally *derived* fontSize -- this
        // is what a real editor's in-memory state looks like, and what this
        // hook's own `normalizeImageElementStatus` (canonicalizeStickyFontState)
        // must reduce to canonical BEFORE reconcileElements ever compares it.
        await result.current.saveDataRef.current?.("drawing", [note, derivedLabel], {}, {});
      });

      const [, savedPayload] = vi.mocked(api.updateDrawing).mock.calls[0]!;
      const savedLabel = (savedPayload.elements as any[]).find((el) => el.id === "sticky-label");
      // Proof, not assumption: the label reconcileElements merged is already
      // canonical (matches the server's), AND its bookkeeping is untouched --
      // there was never a signature mismatch for reconcileElements to react
      // to, because both sides were canonical before the comparison ran.
      expect(savedLabel.fontSize).toBe(20);
      expect(savedLabel.version).toBe(7);
      expect(savedLabel.versionNonce).toBe(11);
      expect(savedLabel.updated).toBe(13);
    });
  });
});
