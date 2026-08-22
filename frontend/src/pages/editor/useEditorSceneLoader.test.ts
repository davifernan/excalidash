import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useEditorSceneLoader } from "./useEditorSceneLoader";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getDrawing: vi.fn(),
  getLibrary: vi.fn(async () => []),
  isAxiosError: vi.fn(() => false),
  API_URL: "",
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

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
  renderHook(() =>
    useEditorSceneLoader({
      id,
      user: null,
      location: { pathname: `/editor/${id ?? ""}`, search: "", hash: "" },
      navigate: vi.fn() as any,
      refs,
      setAccessLevel: vi.fn(),
      setDrawingName: vi.fn(),
      setInitialData,
      setIsReady: vi.fn(),
      setIsSceneLoading: vi.fn(),
      setLoadAttempt: vi.fn(),
      setLoadError: vi.fn(),
      recordElementVersion: vi.fn(),
    }),
  );
  await waitFor(() => expect(setInitialData).toHaveBeenCalledWith(expect.objectContaining({})));
  return { appState: setInitialData.mock.calls.at(-1)?.[0]?.appState, refs };
};

const storedDrawing = (appState: Record<string, any>) => ({
  name: "Board",
  accessLevel: "owner",
  elements: [],
  files: {},
  appState,
  version: 1,
});

describe("the appState a board opens with", () => {
  beforeEach(() => {
    vi.mocked(api.getDrawing).mockReset();
    vi.mocked(api.isAxiosError).mockReturnValue(false);
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
});

describe("temporary drawing load failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.getDrawing).mockReset();
    vi.mocked(api.isAxiosError).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderLoad = () => {
    const setInitialData = vi.fn();
    const setLoadError = vi.fn();
    const setLoadAttempt = vi.fn();
    const refs = buildRefs();
    renderHook(() =>
      useEditorSceneLoader({
        id: "abc",
        user: null,
        location: { pathname: "/editor/abc", search: "", hash: "" },
        navigate: vi.fn() as any,
        refs,
        setAccessLevel: vi.fn(),
        setDrawingName: vi.fn(),
        setInitialData,
        setIsReady: vi.fn(),
        setIsSceneLoading: vi.fn(),
        setLoadAttempt,
        setLoadError,
        recordElementVersion: vi.fn(),
      }),
    );

    return { setInitialData, setLoadAttempt, setLoadError };
  };

  it("retries a network failure and reports the next attempt without showing an error", async () => {
    const error = { request: {} };
    vi.mocked(api.getDrawing).mockRejectedValueOnce(error).mockResolvedValueOnce(storedDrawing({}));
    const { setInitialData, setLoadAttempt, setLoadError } = renderLoad();

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getDrawing).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(api.getDrawing).toHaveBeenCalledTimes(2);
    expect(setLoadAttempt).toHaveBeenCalledWith(2);
    expect(setLoadError).not.toHaveBeenCalledWith(expect.any(String));
    expect(setInitialData).toHaveBeenCalledWith(expect.objectContaining({ elements: [] }));
  });

  it("does not retry a permanent 404 response", async () => {
    const error = { response: { status: 404, data: {} } };
    vi.mocked(api.getDrawing).mockRejectedValue(error);
    const { setLoadError } = renderLoad();

    await act(async () => {
      await Promise.resolve();
    });

    expect(api.getDrawing).toHaveBeenCalledTimes(1);
    expect(setLoadError).toHaveBeenCalledWith("Drawing not found");
  });

  it("shows the terminal error only after exhausting all retries for a server failure", async () => {
    const error = { response: { status: 503, data: {} } };
    vi.mocked(api.getDrawing).mockRejectedValue(error);
    const { setLoadAttempt, setLoadError } = renderLoad();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    expect(api.getDrawing).toHaveBeenCalledTimes(4);
    expect(setLoadAttempt).toHaveBeenLastCalledWith(4);
    expect(setLoadError.mock.calls.filter(([message]) => typeof message === "string")).toHaveLength(
      1,
    );
    expect(setLoadError).toHaveBeenLastCalledWith("Failed to load drawing");
  });
});
