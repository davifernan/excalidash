import { describe, expect, it } from "vitest";
import * as domain from "@excalidash/domain/authz";
import { normalizeCollectionShareRole } from "./sharing";
import type { CollectionShareRole } from "./sharing";

/**
 * Identity proof for the collection-share-role contract's domain extraction
 * (NIL-637, comments/authz domain, slice 7): `sharing.ts` re-exports
 * `CollectionShareRole`/`normalizeCollectionShareRole` from
 * `@excalidash/domain/authz` rather than declaring its own copies -- the
 * same identity check every prior NIL-637 slice ran for its own re-exported
 * bindings.
 */
describe("collection share role contract identity", () => {
  it("sharing.ts re-exports the identical domain function, not a re-declared copy", () => {
    expect(normalizeCollectionShareRole).toBe(domain.normalizeCollectionShareRole);
  });

  it.each([
    { input: "view", expected: "view" },
    { input: "edit", expected: "edit" },
    { input: "comment", expected: null },
    { input: "owner", expected: null },
    { input: "none", expected: null },
    { input: 42, expected: null },
    { input: null, expected: null },
    { input: undefined, expected: null },
  ])("normalizeCollectionShareRole($input) -> $expected", ({ input, expected }) => {
    const result: CollectionShareRole | null = normalizeCollectionShareRole(input);
    expect(result).toBe(expected);
  });
});
