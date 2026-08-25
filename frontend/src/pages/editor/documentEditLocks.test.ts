import { describe, expect, it } from "vitest";
import { parseDocumentEditLocks } from "./documentEditLocks";

describe("document edit lock snapshots", () => {
  it("indexes valid locks and ignores another board or malformed entries", () => {
    expect(
      parseDocumentEditLocks(
        {
          drawingId: "board",
          locks: [
            { assetId: "asset", presenceId: "peer", ownerName: "Alice" },
            { assetId: 4, presenceId: "bad", ownerName: "Bad" },
          ],
        },
        "board",
      ),
    ).toEqual({
      asset: { assetId: "asset", presenceId: "peer", ownerName: "Alice" },
    });
    expect(parseDocumentEditLocks({ drawingId: "other", locks: [] }, "board")).toBeNull();
  });
});
