// @vitest-environment node

import path from "node:path";

import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config";
import vitestConfig from "../../vitest.config";

function domainAlias(config: typeof viteConfig | typeof vitestConfig) {
  const resolved = typeof config === "function"
    ? config({ command: "serve", mode: "test" })
    : config;
  const aliases = resolved.resolve?.alias;

  if (!aliases || Array.isArray(aliases)) return undefined;
  return aliases["@excalidash/domain"];
}

describe("domain source resolution", () => {
  it("makes Vite and Vitest use the same live domain source", () => {
    const expected = path.resolve(__dirname, "../../../packages/domain/src");

    expect(domainAlias(viteConfig)).toBe(expected);
    expect(domainAlias(vitestConfig)).toBe(expected);
  });
});
