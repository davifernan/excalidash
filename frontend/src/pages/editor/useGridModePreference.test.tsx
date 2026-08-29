import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { useGridModePreference } from "./useGridModePreference";

vi.mock("../../api");

const makeCapabilities = (initial: boolean) => {
  let settings = { gridModeEnabled: initial, objectsSnapModeEnabled: true };
  let listener: ((next: typeof settings) => void) | null = null;
  return {
    boardSettings: {
      read: () => ({ ok: true as const, value: settings }),
      subscribe: (next: (value: typeof settings) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    scene: { apply: vi.fn() },
    toggle: (value: boolean) => {
      settings = { gridModeEnabled: value };
      listener?.(settings);
    },
  };
};

describe("useGridModePreference", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the stored user choice without writing it back", async () => {
    vi.mocked(api.getUserPreferences).mockResolvedValue({ gridModeEnabled: true });
    const capabilities = makeCapabilities(false);
    renderHook(() =>
      useGridModePreference({
        active: true,
        boardSettings: capabilities.boardSettings as any,
        scene: capabilities.scene as any,
      }),
    );
    await waitFor(() =>
      expect(capabilities.scene.apply).toHaveBeenCalledWith([
        {
          kind: "settings",
          settings: { gridModeEnabled: true, objectsSnapModeEnabled: false },
        },
      ]),
    );
    expect(api.updateUserPreferences).not.toHaveBeenCalled();
  });

  it("does not request authenticated preferences for an inactive guest editor", () => {
    const capabilities = makeCapabilities(false);
    renderHook(() =>
      useGridModePreference({
        active: false,
        boardSettings: capabilities.boardSettings as any,
        scene: capabilities.scene as any,
      }),
    );
    expect(api.getUserPreferences).not.toHaveBeenCalled();
  });

  it("does not overwrite a stored choice when a toggle lands before loading", async () => {
    let resolvePreferences: (value: { gridModeEnabled: boolean }) => void;
    vi.mocked(api.getUserPreferences).mockReturnValue(
      new Promise((resolve) => {
        resolvePreferences = resolve;
      }),
    );
    const capabilities = makeCapabilities(true);
    renderHook(() =>
      useGridModePreference({
        active: true,
        boardSettings: capabilities.boardSettings as any,
        scene: capabilities.scene as any,
      }),
    );
    act(() => capabilities.toggle(false));
    resolvePreferences!({ gridModeEnabled: true });
    await waitFor(() =>
      expect(api.updateUserPreferences).toHaveBeenCalledWith({ gridModeEnabled: false }),
    );
    expect(capabilities.scene.apply).not.toHaveBeenCalled();
  });

  it("persists the final of several toggles while loading", async () => {
    let resolvePreferences: (value: { gridModeEnabled: boolean }) => void;
    vi.mocked(api.getUserPreferences).mockReturnValue(
      new Promise((resolve) => {
        resolvePreferences = resolve;
      }),
    );
    const capabilities = makeCapabilities(true);
    renderHook(() =>
      useGridModePreference({
        active: true,
        boardSettings: capabilities.boardSettings as any,
        scene: capabilities.scene as any,
      }),
    );
    act(() => {
      capabilities.toggle(false);
      capabilities.toggle(true);
    });
    resolvePreferences!({ gridModeEnabled: false });
    await waitFor(() =>
      expect(api.updateUserPreferences).toHaveBeenCalledWith({ gridModeEnabled: true }),
    );
    expect(api.updateUserPreferences).toHaveBeenCalledTimes(1);
  });
});
