import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as api from "../../api";
import { useToolbarFeaturePreferences } from "./useToolbarFeaturePreferences";
import type { EditorFeatureId } from "./featureRegistry";

vi.mock("../../api");

const KNOWN_IDS: readonly EditorFeatureId[] = ["workshop-timer", "voting", "comments"];

describe("useToolbarFeaturePreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables every known feature by default, before the stored preference loads", () => {
    vi.mocked(api.getUserPreferences).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));

    expect(result.current.isEnabled("voting")).toBe(true);
    expect(result.current.isEnabled("comments")).toBe(true);
  });

  it("narrows to a previously stored selection once it loads", async () => {
    vi.mocked(api.getUserPreferences).mockResolvedValue({ toolbarFeatureIds: ["comments"] });

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));

    await waitFor(() => expect(result.current.isEnabled("voting")).toBe(false));
    expect(result.current.isEnabled("comments")).toBe(true);
  });

  it("drops a stored id the registry no longer knows, instead of offering a dead toggle", async () => {
    vi.mocked(api.getUserPreferences).mockResolvedValue({
      toolbarFeatureIds: ["comments", "retired-feature"],
    });

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));

    await waitFor(() => expect(result.current.isEnabled("comments")).toBe(true));
    expect(result.current.isEnabled("voting")).toBe(false);
  });

  it("keeps every applicable feature on for an anonymous/offline viewer whose read fails", async () => {
    vi.mocked(api.getUserPreferences).mockRejectedValue(new Error("401"));

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));

    await Promise.resolve();
    expect(result.current.isEnabled("voting")).toBe(true);
    expect(result.current.isEnabled("comments")).toBe(true);
  });

  it("toggling off from the implicit all-enabled default persists everything except that one id", async () => {
    vi.mocked(api.getUserPreferences).mockResolvedValue({});
    vi.mocked(api.updateUserPreferences).mockResolvedValue({});

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));
    await waitFor(() => expect(result.current.isEnabled("voting")).toBe(true));

    act(() => result.current.toggle("voting"));

    expect(result.current.isEnabled("voting")).toBe(false);
    expect(result.current.isEnabled("comments")).toBe(true);
    expect(vi.mocked(api.updateUserPreferences)).toHaveBeenCalledWith({
      toolbarFeatureIds: ["workshop-timer", "comments"],
    });
  });

  it("toggling a disabled feature back on adds only that id", async () => {
    vi.mocked(api.getUserPreferences).mockResolvedValue({ toolbarFeatureIds: ["comments"] });
    vi.mocked(api.updateUserPreferences).mockResolvedValue({});

    const { result } = renderHook(() => useToolbarFeaturePreferences(KNOWN_IDS));
    await waitFor(() => expect(result.current.isEnabled("voting")).toBe(false));

    act(() => result.current.toggle("voting"));

    expect(result.current.isEnabled("voting")).toBe(true);
    expect(vi.mocked(api.updateUserPreferences)).toHaveBeenCalledWith({
      toolbarFeatureIds: ["comments", "voting"],
    });
  });
});
