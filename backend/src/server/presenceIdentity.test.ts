/**
 * One person, one row -- however many connections they hold.
 *
 * Reported 02.09.2026: joining a board, going back to the dashboard, closing
 * the tab and reopening the link showed the same person several times. A closed
 * tab is not noticed until the socket's ping timeout, so the old connection is
 * still in the registry when the new one arrives. `summarise` already collapsed
 * by account; `listPublic`, which feeds the participant list people actually
 * look at, did not.
 */
import { describe, expect, it } from "vitest";
import { PresenceRegistry, type PresenceEntry } from "./presenceRegistry";

const entry = (over: Partial<PresenceEntry> & { presenceId: string }): PresenceEntry => ({
  accountId: null,
  name: "Someone",
  initials: "S",
  color: "#123456",
  kind: "guest",
  isActive: true,
  selectedElementIds: {},
  allSelected: false,
  actor: "human",
  identityKey: `socket:${over.presenceId}`,
  joinedAt: 1,
  ...over,
});

describe("one person, one row", () => {
  it("collapses a signed-in account that still holds a stale connection", () => {
    const presences = new PresenceRegistry();
    presences.join(
      "board",
      entry({
        presenceId: "old-tab",
        accountId: "user-1",
        identityKey: "account:user-1",
        joinedAt: 100,
        name: "Davi",
      }),
    );
    presences.join(
      "board",
      entry({
        presenceId: "new-tab",
        accountId: "user-1",
        identityKey: "account:user-1",
        joinedAt: 200,
        name: "Davi",
      }),
    );

    const rows = presences.listPublic("board");
    expect(rows).toHaveLength(1);
    // The newest connection represents them: it is the one they are looking at.
    expect(rows[0].presenceId).toBe("new-tab");
  });

  it("collapses an anonymous visitor whose browser carries a stable id", () => {
    const presences = new PresenceRegistry();
    presences.join(
      "board",
      entry({ presenceId: "s1", identityKey: "client:abc123def", joinedAt: 1 }),
    );
    presences.join(
      "board",
      entry({ presenceId: "s2", identityKey: "client:abc123def", joinedAt: 2 }),
    );
    expect(presences.listPublic("board")).toHaveLength(1);
  });

  it("prefers an active connection over a stale idle one, whatever their order", () => {
    // The tab left open in the background must not be the row that represents
    // someone who is currently drawing.
    const presences = new PresenceRegistry();
    presences.join(
      "board",
      entry({ presenceId: "newer-idle", identityKey: "account:u", joinedAt: 900, isActive: false }),
    );
    presences.join(
      "board",
      entry({
        presenceId: "older-active",
        identityKey: "account:u",
        joinedAt: 100,
        isActive: true,
      }),
    );
    const rows = presences.listPublic("board");
    expect(rows).toHaveLength(1);
    expect(rows[0].presenceId).toBe("older-active");
  });

  it("keeps genuinely different people apart", () => {
    const presences = new PresenceRegistry();
    presences.join("board", entry({ presenceId: "a", identityKey: "account:one", name: "One" }));
    presences.join("board", entry({ presenceId: "b", identityKey: "account:two", name: "Two" }));
    presences.join("board", entry({ presenceId: "c", identityKey: "socket:c", name: "Anon" }));
    expect(
      presences
        .listPublic("board")
        .map((row) => row.name)
        .sort(),
    ).toEqual(["Anon", "One", "Two"]);
  });

  it("collapses nothing when there is nothing to go on", () => {
    // Two anonymous visitors with no stable id are two visitors. Guessing they
    // are one would hide a real person, which is worse than showing a stale row.
    const presences = new PresenceRegistry();
    presences.join("board", entry({ presenceId: "x", identityKey: "socket:x" }));
    presences.join("board", entry({ presenceId: "y", identityKey: "socket:y" }));
    expect(presences.listPublic("board")).toHaveLength(2);
  });

  it("still leaves automations out entirely", () => {
    const presences = new PresenceRegistry();
    presences.join(
      "board",
      entry({ presenceId: "bot", identityKey: "account:u", actor: "automation" }),
    );
    presences.join("board", entry({ presenceId: "human", identityKey: "account:v" }));
    const rows = presences.listPublic("board");
    expect(rows).toHaveLength(1);
    expect(rows[0].presenceId).toBe("human");
  });
});
