import { describe, expect, it } from "vitest";
import { orderCommentMarkersForPaint, type MarkerPosition } from "./CommentMarkers";

const marker = (threadId: string): MarkerPosition => ({
  threadId,
  left: 100,
  top: 100,
  resolved: false,
  count: 1,
});

describe("comment marker paint order", () => {
  it("paints the active marker last without disturbing its inactive siblings", () => {
    const positions = [marker("older"), marker("active"), marker("newer")];

    expect(
      orderCommentMarkersForPaint(positions, "active").map(({ threadId }) => threadId),
    ).toEqual(["older", "newer", "active"]);
    expect(positions.map(({ threadId }) => threadId)).toEqual(["older", "active", "newer"]);
  });

  it("preserves source order when no rendered marker is active", () => {
    const positions = [marker("older"), marker("newer")];

    expect(orderCommentMarkersForPaint(positions, null)).toEqual(positions);
    expect(orderCommentMarkersForPaint(positions, "missing")).toEqual(positions);
  });
});
