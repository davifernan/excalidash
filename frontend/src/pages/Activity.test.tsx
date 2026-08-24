import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "./Activity";
import * as api from "../api";
import type { ActivityEventDTO } from "../api/comments";

vi.mock("../components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../api", () => ({
  getCollections: vi.fn(),
  getInbox: vi.fn(),
  getTeamActivity: vi.fn(),
  visitActivityFeed: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

const event = (id: string, createdAt: string): ActivityEventDTO => ({
  id,
  drawingId: "drawing-1",
  drawingName: "Board One",
  actorUserId: "user-a",
  actorName: "Alice",
  verb: "comment.created",
  commentId: `comment-${id}`,
  threadRootId: null,
  elementId: null,
  anchorX: null,
  anchorY: null,
  summary: "hey there",
  createdAt,
});

// 30 == PAGE_SIZE in Activity.tsx: a full page is the signal there may be more.
const PAGE = Array.from({ length: 30 }, (_, i) =>
  event(`e-${i}`, `2026-08-2${9 - Math.floor(i / 10)}T10:${String(i).padStart(2, "0")}:00.000Z`),
);

describe("Activity pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCollections).mockResolvedValue([]);
    vi.mocked(api.getInbox).mockResolvedValue({
      notifications: [],
      unreadCount: 0,
      lastSeenAt: null,
    });
    vi.mocked(api.visitActivityFeed).mockResolvedValue(undefined);
  });

  it("shows a Load more button after a full page, and appends the next page on click", async () => {
    vi.mocked(api.getTeamActivity)
      .mockResolvedValueOnce({ events: PAGE })
      .mockResolvedValueOnce({ events: [event("e-extra", "2026-08-20T09:00:00.000Z")] });

    render(
      <MemoryRouter>
        <Activity />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByTestId("activity-event")).toHaveLength(30));
    expect(screen.getByTestId("activity-load-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("activity-load-more"));

    await waitFor(() => expect(screen.getAllByTestId("activity-event")).toHaveLength(31));
    expect(screen.queryByTestId("activity-load-more")).not.toBeInTheDocument();

    expect(api.getTeamActivity).toHaveBeenNthCalledWith(2, {
      before: PAGE[PAGE.length - 1].createdAt,
    });
  });

  it("does not show Load more when the first page is already short", async () => {
    vi.mocked(api.getTeamActivity).mockResolvedValueOnce({
      events: [event("e-1", "2026-08-20T09:00:00.000Z")],
    });

    render(
      <MemoryRouter>
        <Activity />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByTestId("activity-event")).toHaveLength(1));
    expect(screen.queryByTestId("activity-load-more")).not.toBeInTheDocument();
  });
});
