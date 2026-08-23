import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLibraryImportFromUrl } from "./useLibraryImportFromUrl";
import type { UiCapability } from "../../integrations/excalidraw/capabilities";

const updateLibrary = vi.fn();
vi.mock("../../api", () => ({ updateLibrary: (...args: unknown[]) => updateLibrary(...args) }));

const errorToast = vi.fn();
const successToast = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => errorToast(...a),
    success: (...a: unknown[]) => successToast(...a),
    // loading and info have to exist: without them the hook throws a TypeError
    // that the outer catch turns into an error toast -- and the refusal test
    // then passes for a reason that has nothing to do with the refusal.
    loading: vi.fn(),
    info: vi.fn(),
  },
}));

const uiWith = (result: unknown) =>
  ({ importLibrary: vi.fn(async () => result) }) as unknown as UiCapability;

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#addLibrary=https://example.test/lib.excalidrawlib";
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })),
  );
});

describe("importing a library from the URL", () => {
  /**
   * The raw call threw on refusal and the surrounding catch reported it. The
   * capability answers instead of throwing, so a refusal that is not re-raised
   * would leave the user with a success toast for a library that never arrived.
   */
  it("tells the user when the import was refused", async () => {
    renderHook(() =>
      useLibraryImportFromUrl({
        ui: uiWith({ ok: false, code: "unsupported" }),
        isReady: true,
        user: {},
      }),
    );

    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(successToast).not.toHaveBeenCalled();
    expect(updateLibrary).not.toHaveBeenCalled();
  });

  it("persists the items the editor reports back on success", async () => {
    renderHook(() =>
      useLibraryImportFromUrl({
        ui: uiWith({ ok: true, value: [{ id: "one" }] }),
        isReady: true,
        user: {},
      }),
    );

    await waitFor(() => expect(successToast).toHaveBeenCalled());
    expect(updateLibrary).toHaveBeenCalledWith([{ id: "one" }]);
  });
});
