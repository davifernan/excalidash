import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLibraryImportFromUrl } from "./useLibraryImportFromUrl";
import type { UiCapability } from "../../integrations/excalidraw/capabilities";

const updateLibrary = vi.fn();
vi.mock("../../api", () => ({ updateLibrary: (...args: unknown[]) => updateLibrary(...args) }));

const notification = vi.fn();
vi.mock("../../notifications", () => ({
  notify: (...args: unknown[]) => notification(...args),
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

    await waitFor(() =>
      expect(notification).toHaveBeenCalledWith("error", expect.any(String), {
        key: "library-import",
      }),
    );
    expect(notification.mock.calls.some(([severity]) => severity === "success")).toBe(false);
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

    await waitFor(() =>
      expect(notification).toHaveBeenCalledWith("success", expect.any(String), {
        key: "library-import",
      }),
    );
    expect(updateLibrary).toHaveBeenCalledWith([{ id: "one" }]);
  });
});
