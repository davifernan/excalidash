import { describe, expect, it } from "vitest";
import { boardAgentFocusTargetsFromResult } from "./presence";

describe("Agent Presence focus projection", () => {
  it("keeps readFrame focused on the frame rather than every returned child", () => {
    expect(
      boardAgentFocusTargetsFromResult("readFrame", {
        frame: { id: "frame-a" },
        elements: [{ id: "child-a" }, { id: "child-b" }],
      }),
    ).toEqual(["frame-a"]);
  });

  it("projects only already-authorized result ids for graph and search reads", () => {
    expect(
      boardAgentFocusTargetsFromResult("followEdge", {
        edge: { id: "edge-a" },
        start: { id: "start-a" },
        end: null,
        semantics: { kind: "unspecified" },
      }),
    ).toEqual(["edge-a", "start-a"]);
    expect(
      boardAgentFocusTargetsFromResult("search", [
        { id: "answer-a" },
        { id: "answer-a" },
        { text: "no id" },
      ]),
    ).toEqual(["answer-a"]);
  });

  it("does not infer a target from non-reading tools or rendered bytes", () => {
    expect(boardAgentFocusTargetsFromResult("overview", { id: "not-a-target" })).toEqual([]);
    expect(
      boardAgentFocusTargetsFromResult("render", {
        svg: '<svg id="not-an-element-id" />',
      }),
    ).toEqual([]);
  });
});
