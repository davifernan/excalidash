import { describe, expect, it } from "vitest";

import {
  EXPECTED_API_METHODS,
  EXPECTED_EXPORTS,
  verifyApiMethods,
  verifyCssSelectors,
  verifyExports,
  verifySeams,
  verifySelectors,
} from "./seams";

const fullApi = {
  getAppState: () => ({}),
  getSceneElements: () => [],
  getSceneElementsIncludingDeleted: () => [],
  getFiles: () => ({}),
  addFiles: () => {},
  updateScene: () => {},
  onChange: () => () => {},
  onPointerDown: () => () => {},
  setActiveTool: () => {},
  updateLibrary: async () => {},
  onUserFollow: () => () => {},
  onScrollChange: () => () => {},
} satisfies Record<(typeof EXPECTED_API_METHODS)[number], (...args: never[]) => unknown>;

describe("checking the installed package", () => {
  it("finds every export this application calls in the pinned version", () => {
    // If this ever fails on the pinned version, the pin moved under us.
    expect(verifyExports()).toEqual([]);
  });

  it("knows what it is looking for", () => {
    expect(EXPECTED_EXPORTS.length).toBeGreaterThan(10);
    expect(EXPECTED_API_METHODS).toContain("onUserFollow");
    expect(EXPECTED_API_METHODS).toContain("onScrollChange");
  });
});

describe("checking the imperative handle", () => {
  it("accepts a handle whose calls return every consumed shape", async () => {
    await expect(verifyApiMethods(fullApi)).resolves.toEqual([]);
  });

  it("names exactly the method that is gone", async () => {
    const { onScrollChange: _dropped, ...withoutOne } = fullApi;
    await expect(verifyApiMethods(withoutOne)).resolves.toEqual(["onScrollChange"]);
  });

  it("names a property that is present but is not callable", async () => {
    await expect(
      verifyApiMethods({ ...fullApi, updateScene: "no longer a function" }),
    ).resolves.toEqual(["updateScene"]);
  });

  it("names a callable method whose return shape changed", async () => {
    await expect(
      verifyApiMethods({ ...fullApi, getAppState: () => Promise.resolve({}) }),
    ).resolves.toEqual(["getAppState"]);
  });

  it("rejects an array where the application consumes an AppState object", async () => {
    await expect(verifyApiMethods({ ...fullApi, getAppState: () => [] })).resolves.toEqual([
      "getAppState",
    ]);
  });

  it("reports everything for a handle that is not there at all", async () => {
    await expect(verifyApiMethods(null)).resolves.toEqual([...EXPECTED_API_METHODS]);
  });
});

describe("checking the markup", () => {
  it("names the selectors that stopped matching", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="excalidraw"></div>';
    const missing = verifySelectors(container);
    expect(missing).toContain("toolbar");
    expect(missing).not.toContain("root");
  });

  it("names CSS selectors that stopped matching", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="help-icon"></div>';

    const missing = verifyCssSelectors(container, ["helpIcon", "mainMenuTrigger"]);

    expect(missing).toEqual(["mainMenuTrigger"]);
  });
});

describe("the whole surface at once", () => {
  it("separates what is gone from what merely stopped matching", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="excalidraw"></div>';
    const { onUserFollow: _gone, ...withoutOne } = fullApi;

    const report = await verifySeams(withoutOne, container);

    expect(report.missing).toContain("api:onUserFollow");
    expect(report.changed).toContain("selector:toolbar");
    expect(report.checked).toBeGreaterThan(EXPECTED_API_METHODS.length);
  });

  it("counts everything it checked, so a shrinking check is visible", async () => {
    const report = await verifySeams(fullApi, null);
    expect(report.checked).toBe(
      EXPECTED_EXPORTS.length + EXPECTED_API_METHODS.length + report.changed.length,
    );
  });
});
