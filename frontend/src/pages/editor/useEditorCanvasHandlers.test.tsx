import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const notification = vi.hoisted(() => vi.fn());
vi.mock("../../notifications", () => ({ notify: notification }));

vi.mock("./droppedImages", () => ({
  getDroppedImageFiles: (dataTransfer: any) => Array.from(dataTransfer?.files || []),
  loadDroppedImageData: async (file: any) => ({
    fileId: file.name,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,bytes",
    created: 1,
    width: 100,
    height: 100,
  }),
  MULTI_IMAGE_DROP_GAP: 24,
}));

import { useEditorCanvasHandlers } from "./useEditorCanvasHandlers";

describe("editor canvas capability failures", () => {
  it("does not treat a failed files.read as an empty successful read", () => {
    const fileCapability = {
      read: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "files.read",
      })),
    } as any;
    const api = {
      getFiles: () => ({}),
      getSceneElementsIncludingDeleted: () => [{ id: "element", type: "rectangle" }],
    };
    const ref = <T,>(current: T) => ({ current });
    const { result } = renderHook(() =>
      useEditorCanvasHandlers({
        canEdit: true,
        canUploadFiles: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability,
        isReady: false,
        refs: {
          excalidrawAPI: ref(api),
          hasHydratedInitialScene: ref(true),
          hasSceneChangesSinceLoad: ref(false),
          initialSceneElements: ref<readonly any[]>([]),
          isBootstrappingScene: ref(false),
          isHistoryPreviewing: ref(false),
          isSyncing: ref(false),
          pendingSyncFingerprint: ref(null),
          isUnmounting: ref(false),
          lastLocalChangeAt: ref(0),
          lastPersistedAppStateSig: ref<string | null>(null),
          latestAppState: ref({}),
          latestElements: ref<readonly any[]>([]),
          latestFiles: ref({}),
          debouncedSave: ref(null),
          suspiciousBlankLoad: ref(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene: {} as any,
        viewport: {} as any,
        broadcastChanges: vi.fn(),
      }),
    );

    expect(() => result.current.handleCanvasChange([], {}, undefined)).toThrow(
      "files.read failed (editor-changed)",
    );
  });

  it("keeps the import error visible when the scene rejects a multi-image drop", async () => {
    const ref = <T,>(current: T) => ({ current });
    const scene = {
      apply: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "scene.apply",
      })),
    } as any;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    notification.mockClear();
    const { result } = renderHook(() =>
      useEditorCanvasHandlers({
        canEdit: true,
        canUploadFiles: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability: {
          add: vi.fn(() => ({ ok: true, value: undefined })),
          read: vi.fn(() => ({ ok: true, value: {} })),
        } as any,
        isReady: false,
        refs: {
          excalidrawAPI: ref({}),
          hasHydratedInitialScene: ref(true),
          hasSceneChangesSinceLoad: ref(false),
          initialSceneElements: ref<readonly any[]>([]),
          isBootstrappingScene: ref(false),
          isHistoryPreviewing: ref(false),
          isSyncing: ref(false),
          pendingSyncFingerprint: ref(null),
          isUnmounting: ref(false),
          lastLocalChangeAt: ref(0),
          lastPersistedAppStateSig: ref<string | null>(null),
          latestAppState: ref({}),
          latestElements: ref<readonly any[]>([{ id: "existing", type: "rectangle" }]),
          latestFiles: ref({}),
          debouncedSave: ref(null),
          suspiciousBlankLoad: ref(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene,
        viewport: {
          toScene: vi.fn(() => ({ ok: true, value: { x: 100, y: 100 } })),
        } as any,
        broadcastChanges: vi.fn(),
      }),
    );
    const event = {
      clientX: 100,
      clientY: 100,
      dataTransfer: {
        files: [
          { name: "one.png", type: "image/png" },
          { name: "two.png", type: "image/png" },
        ],
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as any;

    await result.current.handleCanvasDropCapture(event);

    expect(scene.apply).toHaveBeenCalled();
    const logged = JSON.parse(error.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      message: "[Editor] Failed to import dropped images",
      error: { message: "scene.apply failed (editor-changed)" },
    });
    expect(notification).toHaveBeenCalledWith("error", "Failed to import dropped images");
    error.mockRestore();
  });
});

describe("NIL-685 fingerprint guard", () => {
  const ref = <T,>(current: T) => ({ current });

  const makeHandlers = (overrides: {
    pendingSyncFingerprint: Map<string, string> | null;
    isSyncing?: boolean;
    broadcastChanges?: ReturnType<typeof vi.fn>;
  }) => {
    const broadcastChanges = overrides.broadcastChanges ?? vi.fn();
    const isSyncingRef = ref(overrides.isSyncing ?? true);
    const pendingSyncFingerprintRef = ref(overrides.pendingSyncFingerprint);
    const { result } = renderHook(() =>
      useEditorCanvasHandlers({
        canEdit: true,
        canUploadFiles: true,
        debouncedSavePreview: vi.fn(),
        drawingId: "drawing-1",
        emitFilesDeltaIfNeeded: vi.fn(),
        fileCapability: { read: vi.fn(() => ({ ok: true, value: {} })) } as any,
        isReady: false,
        refs: {
          excalidrawAPI: ref({}),
          hasHydratedInitialScene: ref(true),
          hasSceneChangesSinceLoad: ref(false),
          initialSceneElements: ref<readonly any[]>([]),
          isBootstrappingScene: ref(false),
          isHistoryPreviewing: ref(false),
          isSyncing: isSyncingRef,
          pendingSyncFingerprint: pendingSyncFingerprintRef,
          isUnmounting: ref(false),
          lastLocalChangeAt: ref(0),
          lastPersistedAppStateSig: ref<string | null>(null),
          latestAppState: ref({}),
          latestElements: ref<readonly any[]>([]),
          latestFiles: ref({}),
          debouncedSave: ref(null),
          suspiciousBlankLoad: ref(false),
        },
        resolveSafeSnapshot: () => ({
          prevented: false,
          staleEmptySnapshot: false,
          staleNonRenderableSnapshot: false,
        }),
        scene: {} as any,
        viewport: {} as any,
        broadcastChanges,
      }),
    );
    return { result, isSyncingRef, pendingSyncFingerprintRef, broadcastChanges };
  };

  it("does not settle when a fingerprinted id never appears in the onChange elements (Hans-Friedrich, PR #249)", () => {
    // Fingerprint expects BOTH "a" and "b" to reach these versions. This
    // onChange's `elements` carries "a" at the expected version but never
    // mentions "b" at all -- e.g. it was fingerprinted from a batch that
    // also touched an element this particular render pass doesn't include.
    const fingerprint = new Map([
      ["a", "1:100"],
      ["b", "2:200"],
    ]);
    const { result, isSyncingRef, pendingSyncFingerprintRef } = makeHandlers({
      pendingSyncFingerprint: fingerprint,
      isSyncing: true,
    });

    result.current.handleCanvasChange([{ id: "a", version: 1, versionNonce: 100 }], {}, {});

    // The old loop only ever visited ids that already appeared in `elements`
    // and never checked the reverse direction, so it reported "settled"
    // here even though "b" was never observed -- exactly the race this
    // guard exists to close, reopened as "reports done too early" instead
    // of "opens too early".
    expect(pendingSyncFingerprintRef.current).toBe(fingerprint);
    expect(isSyncingRef.current).toBe(true);
  });

  it("settles once every fingerprinted id is actually observed at its expected version", () => {
    const fingerprint = new Map([
      ["a", "1:100"],
      ["b", "2:200"],
    ]);
    const { result, isSyncingRef, pendingSyncFingerprintRef } = makeHandlers({
      pendingSyncFingerprint: fingerprint,
      isSyncing: true,
    });

    result.current.handleCanvasChange(
      [
        { id: "a", version: 1, versionNonce: 100 },
        { id: "b", version: 2, versionNonce: 200 },
      ],
      {},
      {},
    );

    expect(pendingSyncFingerprintRef.current).toBeNull();
    expect(isSyncingRef.current).toBe(false);
  });

  it("still broadcasts a concurrent local edit to an unrelated element while the fingerprint has not settled (Hans-Friedrich, PR #249)", () => {
    // "a" is still mid-flight (its onChange hasn't reported the applied
    // version yet); "c" is a completely different element this same
    // onChange call also carries, having genuinely changed locally. The
    // old code returned unconditionally whenever `isSyncingRef.current` was
    // still true, dropping "c" along with "a" -- nobody ever saw "c" move.
    const fingerprint = new Map([["a", "1:100"]]);
    const { result, broadcastChanges } = makeHandlers({
      pendingSyncFingerprint: fingerprint,
      isSyncing: true,
    });

    const elements = [
      { id: "a", version: 0, versionNonce: 0 }, // not yet at the expected version
      { id: "c", version: 5, versionNonce: 500 },
    ];
    result.current.handleCanvasChange(elements, {}, {});

    expect(broadcastChanges).toHaveBeenCalledWith(elements, {});
  });
});
