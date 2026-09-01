import { describe, expect, it } from "vitest";
import { PresenceRegistry, type PresenceEntry } from "./presenceRegistry";

const entry = (overrides: Partial<PresenceEntry> = {}): PresenceEntry => ({
  presenceId: "s1",
  accountId: "u1",
  name: "Davi",
  initials: "DA",
  color: "#3b82f6",
  kind: "member",
  isActive: true,
  selectedElementIds: {},
  actor: "human",
  ...overrides,
});

describe("presence registry", () => {
  it("counts two tabs of one person as one person", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry({ presenceId: "s1" }));
    registry.join("d1", entry({ presenceId: "s2", isActive: false }));

    const summary = registry.summarise("d1");
    expect(summary.members).toHaveLength(1);
    expect(summary.members[0].accountId).toBe("u1");
  });

  it("counts guests instead of naming them", () => {
    const registry = new PresenceRegistry();
    registry.join(
      "d1",
      entry({ presenceId: "g1", accountId: null, kind: "guest", name: "Guest A7" }),
    );
    registry.join(
      "d1",
      entry({ presenceId: "g2", accountId: null, kind: "guest", name: "Guest B3" }),
    );

    const summary = registry.summarise("d1");
    expect(summary.members).toHaveLength(0);
    expect(summary.guestCount).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("Guest");
  });

  it("keeps the owner badge when the same person also has a plain tab open", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry({ presenceId: "s1", kind: "member" }));
    registry.join("d1", entry({ presenceId: "s2", kind: "owner" }));

    expect(registry.summarise("d1").members[0].kind).toBe("owner");
  });

  it("forgets a board once the last connection goes", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry());
    registry.leave("d1", "s1");

    expect(registry.occupiedDrawingIds()).toEqual([]);
    expect(registry.list("d1")).toEqual([]);
  });

  it("reports whether an activity flag actually changed anything", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry({ isActive: true }));

    expect(registry.setActive("d1", "s1", true)).toBe(false);
    expect(registry.setActive("d1", "s1", false)).toBe(true);
    expect(registry.setActive("d1", "missing", false)).toBe(false);
  });

  it("clears a selection when its presence becomes inactive", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry({ selectedElementIds: { selected: true }, allSelected: true }));

    expect(registry.setActive("d1", "s1", false)).toBe(true);
    expect(registry.get("d1", "s1")?.selectedElementIds).toEqual({});
    expect(registry.get("d1", "s1")?.allSelected).toBe(false);
    expect(registry.setSelection("d1", "s1", ["late-update"])).toBe(false);
    expect(registry.get("d1", "s1")?.selectedElementIds).toEqual({});
  });
});

describe("what leaves the server", () => {
  // A share link puts anonymous visitors into the same room as the owner, and
  // the room broadcast used to carry the owner's account id with it. That is a
  // handle to a real row: once a visitor has it, they recognise the same person
  // on every other board they are ever given a link to. subjectKey exists
  // precisely so account ids stay server-side, and this is the projection that
  // holds the socket side to it.
  it("keeps the account id out of the public projection", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", {
      presenceId: "socket-owner",
      accountId: "owner-account-id",
      name: "Owner",
      initials: "OW",
      color: "#10b981",
      kind: "owner",
      isActive: true,
      selectedElementIds: {},
      actor: "human",
    });

    const [entry] = registry.listPublic("d1");
    expect(entry).not.toHaveProperty("accountId");
    expect(JSON.stringify(entry)).not.toContain("owner-account-id");
    // Everything the other people in the room actually need is still there.
    expect(entry).toMatchObject({ presenceId: "socket-owner", name: "Owner", kind: "owner" });
    // The server keeps it for itself: the member summary still groups by account.
    expect(registry.summarise("d1").members[0].accountId).toBe("owner-account-id");
  });

  it("keeps selections out of the public presence projection", () => {
    const registry = new PresenceRegistry();
    registry.join("d1", entry({ selectedElementIds: { "element-1": true } }));

    const [publicEntry] = registry.listPublic("d1");

    expect(publicEntry).not.toHaveProperty("selectedElementIds");
    expect(registry.get("d1", "s1")?.selectedElementIds).toEqual({ "element-1": true });
  });

  describe("automations are not people", () => {
    // An API key carries its owner's name and colour, so an automation that
    // reached a people-view would be indistinguishable from the person -- and
    // several connections made that person appear several times.
    const human = entry({ presenceId: "human-socket", accountId: "u1" });
    const automation = entry({
      presenceId: "mcp-socket",
      accountId: "u1",
      actor: "automation",
    });

    it("keeps an automation out of the board roster while the person stays", () => {
      const registry = new PresenceRegistry();
      registry.join("d1", human);
      registry.join("d1", automation);

      const roster = registry.listPublic("d1");
      expect(roster).toHaveLength(1);
      expect(roster[0]!.presenceId).toBe("human-socket");
    });

    it("does not report a person as present when only their key is", () => {
      // Sharper than a duplicate: `summarise` groups by account, so an
      // automation would fold silently into its owner and the board would
      // claim the person is there.
      const registry = new PresenceRegistry();
      registry.join("d1", automation);

      const summary = registry.summarise("d1");
      expect(summary.members).toHaveLength(0);
      expect(summary.guestCount).toBe(0);
    });

    it("does not draw an automation's selection as somebody's selection", () => {
      const registry = new PresenceRegistry();
      registry.join("d1", automation);
      registry.setSelection("d1", "mcp-socket", ["el-1"], false);

      expect(registry.selectionSnapshot("d1").selections).toHaveLength(0);
    });

    it("does not route agent events to an automation", () => {
      const registry = new PresenceRegistry();
      registry.join("d1", human);
      registry.join("d1", automation);

      expect(registry.agentRecipientIds("d1", { kind: "drawing" })).toEqual(["human-socket"]);
    });

    // The guard. The bug this replaces was not "somebody forgot listPublic" --
    // it was that nothing reminded them. This enumerates every view that
    // describes who is on a board, so a view added later has to be listed here
    // and answer the question, instead of silently repeating the same gap.
    it("keeps automations out of EVERY people-facing view", () => {
      const registry = new PresenceRegistry();
      registry.join("d1", automation);
      registry.setSelection("d1", "mcp-socket", ["el-1"], false);

      const peopleViews: Record<string, () => unknown[]> = {
        listPublic: () => registry.listPublic("d1"),
        summariseMembers: () => registry.summarise("d1").members,
        selectionSnapshot: () => registry.selectionSnapshot("d1").selections,
        agentRecipientIds: () => registry.agentRecipientIds("d1", { kind: "drawing" }),
      };

      for (const [name, read] of Object.entries(peopleViews)) {
        expect(read(), `${name} exposed an automation`).toHaveLength(0);
      }
    });
  });
});
