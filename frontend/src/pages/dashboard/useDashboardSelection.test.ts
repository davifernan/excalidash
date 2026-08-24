import { describe, expect, it } from "vitest";
import type { DrawingSummary } from "../../types";
import { retainPresentSelectedIds } from "./useDashboardSelection";

const drawing = (id: string): DrawingSummary => ({
  id,
  name: id,
  collectionId: null,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
});

describe("retainPresentSelectedIds", () => {
  it("keeps selected drawings that remain in a refreshed list", () => {
    const selectedIds = new Set(["d1", "d2"]);

    expect(retainPresentSelectedIds(selectedIds, [drawing("d2"), drawing("d1")])).toBe(selectedIds);
  });

  it("drops selected drawings that are absent from a refreshed list", () => {
    const retainedIds = retainPresentSelectedIds(new Set(["visible", "removed"]), [
      drawing("visible"),
    ]);

    expect([...retainedIds]).toEqual(["visible"]);
  });
});
