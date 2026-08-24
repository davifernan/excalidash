import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import * as api from "../api";
import type { NotificationDTO } from "../api/comments";

vi.mock("../components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../api", () => ({
  getCollections: vi.fn(),
  getInbox: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

const notification = (id: string, createdAt: string): NotificationDTO => ({
  id,
  kind: "mention",
  readAt: null,
  createdAt,
  event: {
    id: `event-${id}`,
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
  },
});

// 30 == PAGE_SIZE in Inbox.tsx: a full page is the signal there may be more.
const PAGE = Array.from({ length: 30 }, (_, i) =>
  notification(
    `n-${i}`,
    `2026-08-2${9 - Math.floor(i / 10)}T10:${String(i).padStart(2, "0")}:00.000Z`,
  ),
);

describe("Inbox pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCollections).mockResolvedValue([]);
  });

  it("shows a Load more button after a full page, and appends the next page on click", async () => {
    vi.mocked(api.getInbox)
      .mockResolvedValueOnce({ notifications: PAGE, unreadCount: 0, lastSeenAt: null })
      .mockResolvedValueOnce({
        notifications: [notification("n-extra", "2026-08-20T09:00:00.000Z")],
        unreadCount: 0,
        lastSeenAt: null,
      });

    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByTestId("inbox-notification")).toHaveLength(30));
    expect(screen.getByTestId("inbox-load-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("inbox-load-more"));

    await waitFor(() => expect(screen.getAllByTestId("inbox-notification")).toHaveLength(31));
    // A short (< PAGE_SIZE) second page means there is nothing further.
    expect(screen.queryByTestId("inbox-load-more")).not.toBeInTheDocument();

    expect(api.getInbox).toHaveBeenNthCalledWith(2, {
      unreadOnly: false,
      before: PAGE[PAGE.length - 1].createdAt,
    });
  });

  it("does not show Load more when the first page is already short", async () => {
    vi.mocked(api.getInbox).mockResolvedValueOnce({
      notifications: [notification("n-1", "2026-08-20T09:00:00.000Z")],
      unreadCount: 0,
      lastSeenAt: null,
    });

    render(
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByTestId("inbox-notification")).toHaveLength(1));
    expect(screen.queryByTestId("inbox-load-more")).not.toBeInTheDocument();
  });
});
