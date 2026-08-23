import { describe, expect, it } from "vitest";

import {
  EXPECTED_API_METHODS,
  EXPECTED_EXPORTS,
  verifyApiMethods,
  verifyExports,
  verifySeams,
  verifySelectors,
} from "./seams";

const fullApi = Object.fromEntries(EXPECTED_API_METHODS.map((name) => [name, () => {}]));

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
  it("accepts a handle that has everything", () => {
    expect(verifyApiMethods(fullApi)).toEqual([]);
  });

  it("names exactly the method that is gone", () => {
    const { onScrollChange: _dropped, ...withoutOne } = fullApi;
    expect(verifyApiMethods(withoutOne)).toEqual(["onScrollChange"]);
  });

  it("names a property that is present but is not callable", () => {
    expect(verifyApiMethods({ ...fullApi, updateScene: "no longer a function" })).toEqual([
      "updateScene",
    ]);
  });

  it("reports everything for a handle that is not there at all", () => {
    expect(verifyApiMethods(null)).toEqual([...EXPECTED_API_METHODS]);
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
});

describe("the whole surface at once", () => {
  it("separates what is gone from what merely stopped matching", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="excalidraw"></div>';
    const { onUserFollow: _gone, ...withoutOne } = fullApi;

    const report = verifySeams(withoutOne, container);

    expect(report.missing).toContain("api:onUserFollow");
    expect(report.changed).toContain("selector:toolbar");
    expect(report.checked).toBeGreaterThan(EXPECTED_API_METHODS.length);
  });

  it("counts everything it checked, so a shrinking check is visible", () => {
    const report = verifySeams(fullApi, null);
    expect(report.checked).toBe(
      EXPECTED_EXPORTS.length + EXPECTED_API_METHODS.length + report.changed.length,
    );
  });
});
