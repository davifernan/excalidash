import { expect, test } from "@playwright/test";
import {
  AGENT_CONTEXT_GATE_FIXTURE_VERSION,
  gate1BoardMountFixture,
  gate2PresenceFixture,
  gate3BoardThreadFixture,
  gate4TerminalDecisionFixture,
} from "./fixtures/agentContextGateFixtures";

test.describe("NIL-701: pre-registered Agent Context gate fixtures", () => {
  test("keeps Gate 1's answer, immutable mutation, and forbidden-context attacks fixed", () => {
    expect(AGENT_CONTEXT_GATE_FIXTURE_VERSION).toBe("nil-701-gate-fixtures-v1");
    expect(gate1BoardMountFixture.expectedAnswer).toBe("ORANGE");
    expect(gate1BoardMountFixture.mutationAfterFirstRead.replacementText).toContain("BLUE");
    expect(gate1BoardMountFixture.contexts.filter((context) => context.mounted)).toHaveLength(1);
    expect(gate1BoardMountFixture.forbiddenAccessAttempts).toEqual([
      "search",
      "readElements",
      "followEdge",
      "render",
      "readAsset",
    ]);
  });

  test("keeps Gate 2's six timed samples, public mapping, private audience, and counterbalance fixed", () => {
    expect(gate2PresenceFixture.samples.map((sample) => sample.atSecond)).toEqual([
      0, 5, 10, 15, 20, 25,
    ]);
    expect(gate2PresenceFixture.samples.every((sample) => sample.expected.length === 3)).toBe(true);
    expect(gate2PresenceFixture.publicAgents.map((agent) => agent.contextId)).toEqual([
      "context-atlas",
      "context-beacon",
      "context-cobalt",
    ]);
    expect(gate2PresenceFixture.privateAgent.audience).toBe("private");
    expect(gate2PresenceFixture.comparisonOrder.map((entry) => entry.firstSurface)).toEqual([
      "board-presence",
      "markdown-status-file",
    ]);
  });

  test("keeps Gate 3's information-equivalent task pairs and crossed order fixed", () => {
    expect(gate3BoardThreadFixture.tasks).toHaveLength(4);
    expect(new Set(gate3BoardThreadFixture.tasks.map((task) => task.answer)).size).toBe(4);
    expect(
      gate3BoardThreadFixture.balancedOrder.flatMap((entry) => entry.boardThreadTaskIds).sort(),
    ).toEqual(gate3BoardThreadFixture.tasks.map((task) => task.id).sort());
    expect(
      gate3BoardThreadFixture.balancedOrder.flatMap((entry) => entry.terminalTaskIds).sort(),
    ).toEqual(gate3BoardThreadFixture.tasks.map((task) => task.id).sort());
  });

  test("keeps Gate 4 blocked on Gates 1-3 and every cost/risk decision field", () => {
    expect(gate4TerminalDecisionFixture.prerequisiteGates).toEqual(["gate-1", "gate-2", "gate-3"]);
    expect(gate4TerminalDecisionFixture.representativeScenario.terminalTab).toBe("disabled");
    expect(gate4TerminalDecisionFixture.costRiskChecklist).toHaveLength(10);
    expect(gate4TerminalDecisionFixture.decisionOutcomes).toEqual(["go", "no-go"]);
  });
});
