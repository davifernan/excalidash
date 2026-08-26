import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MutableRefObject } from "react";
import { useEditorSceneLoader } from "./useEditorSceneLoader";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getDrawing: vi.fn(),
  getLibrary: vi.fn(async () => []),
  isAxiosError: () => false,
  API_URL: "",
}));

vi.mock("../../notifications", () => ({ notify: vi.fn() }));

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;

const buildRefs = () => ({
  elementVersionMap: ref(new Map<string, any>()),
  saveQueue: ref(Promise.resolve()),
  latestElements: ref([] as readonly any[]),
  initialSceneElements: ref([] as readonly any[]),
  latestFiles: ref<any>({}),
  lastSyncedFiles: ref<Record<string, any>>({}),
  lastSyncedElementOrderSig: ref(""),
  lastPersistedFiles: ref<Record<string, any>>({}),
  currentDrawingVersion: ref<number | null>(null),
  lastPersistedElements: ref([] as readonly any[]),
  lastPersistedAppStateSig: ref(null as string | null),
  suspiciousBlankLoad: ref(false),
  hasSceneChangesSinceLoad: ref(false),
  excalidrawAPI: ref<any>(null),
  latestAppState: ref<any>(null),
  isBootstrappingScene: ref(false),
  hasHydratedInitialScene: ref(false),
});

const loadScene = async (id: string | undefined, refs = buildRefs()) => {
  const setInitialData = vi.fn();
  const setCanUploadFiles = vi.fn();
  const setCanViewComments = vi.fn();
  renderHook(() =>
    useEditorSceneLoader({
      id,
      user: null,
      location: { pathname: `/editor/${id ?? ""}`, search: "", hash: "" },
      navigate: vi.fn() as any,
      refs,
      setAccessLevel: vi.fn(),
      setCanUploadFiles,
      setCanViewComments,
      setDrawingName: vi.fn(),
      setCollectionId: vi.fn(),
      setCollectionName: vi.fn(),
      setInitialData,
      setIsReady: vi.fn(),
      setIsSceneLoading: vi.fn(),
      setLoadError: vi.fn(),
      recordElementVersion: vi.fn(),
    }),
  );
  await waitFor(() => expect(setInitialData).toHaveBeenCalledWith(expect.objectContaining({})));
  return {
    appState: setInitialData.mock.calls.at(-1)?.[0]?.appState,
    refs,
    setCanUploadFiles,
    setCanViewComments,
  };
};

const storedDrawing = (appState: Record<string, any>) => ({
  name: "Board",
  accessLevel: "owner",
  elements: [],
  files: {},
  appState,
  version: 1,
  capabilities: { uploadFiles: true, viewComments: true },
});

describe("the appState a board opens with", () => {
  beforeEach(() => {
    vi.mocked(api.getDrawing).mockReset();
  });

  it("switches object snapping on for a scratch board", async () => {
    expect((await loadScene(undefined)).appState.objectsSnapModeEnabled).toBe(true);
  });

  it("switches object snapping on for a board that predates the setting", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue(storedDrawing({ viewBackgroundColor: "#fff" }));
    expect((await loadScene("abc")).appState.objectsSnapModeEnabled).toBe(true);
  });

  it("leaves the grid alone on a board that draws on it", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue(storedDrawing({ gridModeEnabled: true }));
    const { appState } = await loadScene("abc");
    expect(appState.objectsSnapModeEnabled).toBe(false);
    expect(appState.gridModeEnabled).toBe(true);
  });

  it("honours a board where snapping was switched off on purpose", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue(storedDrawing({ objectsSnapModeEnabled: false }));
    expect((await loadScene("abc")).appState.objectsSnapModeEnabled).toBe(false);
  });

  it("initializes the ordering signature from the loaded scene", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue({
      ...storedDrawing({}),
      elements: [{ id: "first" }, { id: "second" }],
    });
    const { refs } = await loadScene("abc");

    expect(refs.lastSyncedElementOrderSig.current).not.toBe("");
  });

  it("uses the backend capabilities as the exact upload and comment UX gates", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue({
      ...storedDrawing({}),
      capabilities: { uploadFiles: false, viewComments: true },
    });

    const { setCanUploadFiles, setCanViewComments } = await loadScene("abc");

    expect(setCanUploadFiles).toHaveBeenLastCalledWith(false);
    expect(setCanViewComments).toHaveBeenLastCalledWith(true);
  });
});

describe("workspace context loaded alongside the board (NIL-323/NIL-344)", () => {
  beforeEach(() => {
    vi.mocked(api.getDrawing).mockReset();
  });

  it("passes the fetched collectionId/collectionName straight through", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue({
      ...storedDrawing({}),
      collectionId: "c1",
      collectionName: "Roadmap",
    } as any);
    const setCollectionId = vi.fn();
    const setCollectionName = vi.fn();
    renderHook(() =>
      useEditorSceneLoader({
        id: "abc",
        user: null,
        location: { pathname: "/editor/abc", search: "", hash: "" },
        navigate: vi.fn() as any,
        refs: buildRefs(),
        setAccessLevel: vi.fn(),
        setCanUploadFiles: vi.fn(),
        setCanViewComments: vi.fn(),
        setDrawingName: vi.fn(),
        setCollectionId,
        setCollectionName,
        setInitialData: vi.fn(),
        setIsReady: vi.fn(),
        setIsSceneLoading: vi.fn(),
        setLoadError: vi.fn(),
        recordElementVersion: vi.fn(),
      }),
    );
    await waitFor(() => expect(setCollectionId).toHaveBeenCalledWith("c1"));
    expect(setCollectionName).toHaveBeenCalledWith("Roadmap");
  });

  it("defaults both to null for a board the response sends neither for", async () => {
    vi.mocked(api.getDrawing).mockResolvedValue(storedDrawing({}) as any);
    const setCollectionId = vi.fn();
    const setCollectionName = vi.fn();
    renderHook(() =>
      useEditorSceneLoader({
        id: "abc",
        user: null,
        location: { pathname: "/editor/abc", search: "", hash: "" },
        navigate: vi.fn() as any,
        refs: buildRefs(),
        setAccessLevel: vi.fn(),
        setCanUploadFiles: vi.fn(),
        setCanViewComments: vi.fn(),
        setDrawingName: vi.fn(),
        setCollectionId,
        setCollectionName,
        setInitialData: vi.fn(),
        setIsReady: vi.fn(),
        setIsSceneLoading: vi.fn(),
        setLoadError: vi.fn(),
        recordElementVersion: vi.fn(),
      }),
    );
    await waitFor(() => expect(setCollectionId).toHaveBeenCalledWith(null));
    expect(setCollectionName).toHaveBeenCalledWith(null);
  });
});
