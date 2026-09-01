import { describe, expect, it } from "vitest";
import { parseVoteOptionLabels, parseVotePrompt, VotingRegistry } from "./votingRegistry";

describe("VotingRegistry", () => {
  it("reports idle before any round is opened", () => {
    const registry = new VotingRegistry();
    expect(registry.snapshot("drawing-1")).toEqual({
      drawingId: "drawing-1",
      status: "idle",
      roundId: null,
      prompt: null,
      options: null,
      maxSelections: null,
      tally: null,
      participantCount: null,
    });
  });

  it("opens a round with no tally at all -- not zeroed, absent", () => {
    const registry = new VotingRegistry();
    const result = registry.open("drawing-1", "Ship it?", ["Yes", "No"], 1);
    expect(result.status).toBe("applied");
    const snapshot = registry.snapshot("drawing-1");
    expect(snapshot.status).toBe("open");
    expect(snapshot.tally).toBeNull();
    // Zero, not null: the round exists and nobody has voted yet. The overlay
    // suppresses the line at zero rather than announcing an empty round, but
    // that is a display choice and does not belong in the snapshot.
    expect(snapshot.participantCount).toBe(0);
    expect(snapshot.options).toEqual([
      { id: "0", label: "Yes" },
      { id: "1", label: "No" },
    ]);
  });

  it("rejects opening a round outside the option/selection bounds", () => {
    const registry = new VotingRegistry();
    expect(registry.open("drawing-1", "Prompt", ["Only one"], 1)).toEqual({
      status: "rejected",
      reason: "invalid-round",
    });
    expect(registry.open("drawing-1", "Prompt", ["A", "B"], 3)).toEqual({
      status: "rejected",
      reason: "invalid-round",
    });
  });

  it("keeps cast() from ever revealing a running RESULT while open", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 1);
    const result = registry.cast("drawing-1", "voter-1", ["0"]);
    // A caster learns whether their own ballot was accepted, and how far along
    // the room is -- never how it is leaning.
    //
    // This test used to assert that `participantCount` stayed null while open
    // too. That was a deliberate decision, reversed deliberately: the count is
    // what tells someone whether it is worth waiting before revealing.
    //
    // The line that must not move is the tally. A visible running result
    // changes how the people who have not voted yet will vote; a count does
    // not disclose the outcome.
    expect(result).toEqual({ status: "applied" });
    expect(registry.snapshot("drawing-1").tally).toBeNull();
    expect(registry.snapshot("drawing-1").participantCount).toBe(1);
  });

  it("counts voters, not ballots, so changing a vote does not inflate it", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 1);
    registry.cast("drawing-1", "voter-1", ["0"]);
    registry.cast("drawing-1", "voter-1", ["1"]);
    registry.cast("drawing-1", "voter-2", ["0"]);

    expect(registry.snapshot("drawing-1").participantCount).toBe(2);
    expect(registry.snapshot("drawing-1").tally).toBeNull();
  });

  it("says nothing at all before a round exists", () => {
    const registry = new VotingRegistry();
    expect(registry.snapshot("drawing-1").participantCount).toBeNull();
  });

  it("rejects a ballot naming an option that does not exist in the round", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 1);
    expect(registry.cast("drawing-1", "voter-1", ["not-a-real-option"])).toEqual({
      status: "rejected",
      reason: "invalid-ballot",
    });
  });

  it("rejects a ballot with more selections than the round allows", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B", "C"], 1);
    expect(registry.cast("drawing-1", "voter-1", ["0", "1"])).toEqual({
      status: "rejected",
      reason: "invalid-ballot",
    });
  });

  it("rejects casting when no round is open", () => {
    const registry = new VotingRegistry();
    expect(registry.cast("drawing-1", "voter-1", ["0"])).toEqual({
      status: "rejected",
      reason: "no-open-round",
    });
  });

  it("replaces the whole ballot on recast -- resending the same ballot is a true no-op", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 2);
    registry.cast("drawing-1", "voter-1", ["0", "1"]);
    // Change their mind down to just one option.
    registry.cast("drawing-1", "voter-1", ["0"]);
    // Replay the identical message twice more -- a toggle would flip this
    // back and forth; a set-replace does nothing extra either time.
    registry.cast("drawing-1", "voter-1", ["0"]);
    registry.cast("drawing-1", "voter-1", ["0"]);
    const revealed = registry.reveal("drawing-1");
    expect(revealed?.tally).toEqual({ "0": 1, "1": 0 });
    expect(revealed?.participantCount).toBe(1);
  });

  it("tallies multi-selection ballots per option, not per voter", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B", "C"], 2);
    registry.cast("drawing-1", "voter-1", ["0", "1"]);
    registry.cast("drawing-1", "voter-2", ["1"]);
    registry.cast("drawing-1", "voter-3", ["2"]);
    const revealed = registry.reveal("drawing-1");
    expect(revealed?.tally).toEqual({ "0": 1, "1": 2, "2": 1 });
    expect(revealed?.participantCount).toBe(3);
  });

  it("reveal is idempotent -- a second reveal() never recomputes the tally", () => {
    // A late cast() is already rejected by the "no-open-round" guard once
    // status leaves "open" (tested above), so votesByVoterId genuinely
    // cannot change between two reveal() calls through the public API --
    // asserting the second tally only `toEqual` the first would pass even if
    // `reveal()` recomputed a fresh object on every call, which is exactly
    // the regression this test exists to catch (Hans-Friedrich, PR #65): drop
    // the `if (round.status === "open")` guard in `reveal()` and it still
    // recomputes to the same values from the same unchanged map. `toBe`
    // (reference identity) is the one assertion a recompute cannot satisfy
    // even when its output happens to be equal.
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 1);
    registry.cast("drawing-1", "voter-1", ["0"]);
    const first = registry.reveal("drawing-1");
    registry.cast("drawing-1", "voter-2", ["1"]); // arrives late, after reveal
    const second = registry.reveal("drawing-1");
    expect(second?.tally).toBe(first?.tally);
  });

  it("rejects a cast against a round that is no longer the current one", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "First", ["A", "B"], 1);
    expect(registry.castMatchesRound("drawing-1", "stale-round-id")).toBe(false);
  });

  it("opening a fresh round discards an un-revealed previous one", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "First", ["A", "B"], 1);
    const firstRoundId = registry.snapshot("drawing-1").roundId;
    registry.open("drawing-1", "Second", ["C", "D"], 1);
    expect(registry.castMatchesRound("drawing-1", firstRoundId as string)).toBe(false);
    expect(registry.snapshot("drawing-1").prompt).toBe("Second");
  });

  it("close returns to idle and drops the round", () => {
    const registry = new VotingRegistry();
    registry.open("drawing-1", "Prompt", ["A", "B"], 1);
    const snapshot = registry.close("drawing-1");
    expect(snapshot.status).toBe("idle");
    expect(registry.cast("drawing-1", "voter-1", ["0"])).toEqual({
      status: "rejected",
      reason: "no-open-round",
    });
  });
});

describe("parseVoteOptionLabels", () => {
  it("accepts two to twelve non-empty labels", () => {
    expect(parseVoteOptionLabels(["A", "B"])).toEqual(["A", "B"]);
    expect(parseVoteOptionLabels(["A"])).toBeNull();
    expect(parseVoteOptionLabels(Array.from({ length: 13 }, (_, i) => `Option ${i}`))).toBeNull();
  });

  it("rejects a blank label", () => {
    expect(parseVoteOptionLabels(["A", "   "])).toBeNull();
  });

  it("rejects a non-array", () => {
    expect(parseVoteOptionLabels("A,B")).toBeNull();
  });
});

describe("parseVotePrompt", () => {
  it("trims and accepts a reasonable prompt", () => {
    expect(parseVotePrompt("  Ship it?  ")).toBe("Ship it?");
  });

  it("rejects an empty or oversized prompt", () => {
    expect(parseVotePrompt("   ")).toBeNull();
    expect(parseVotePrompt("x".repeat(301))).toBeNull();
  });
});
