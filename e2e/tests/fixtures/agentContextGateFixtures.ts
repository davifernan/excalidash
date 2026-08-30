/**
 * NIL-701's pre-registered inputs for the four Agent Context release gates.
 *
 * These values are fixtures, not observations: changing them after a run
 * would change the question the run answered. The companion fixture spec
 * guards their structural invariants; the human gate operator records the
 * actual observations in the NIL-701 run record.
 */

export const AGENT_CONTEXT_GATE_FIXTURE_VERSION = "nil-701-gate-fixtures-v1";

export const gate1BoardMountFixture = {
  drawingName: "Gate 1 — immutable mount",
  revisionLabel: "gate-1-revision-orange",
  question: "What is the launch answer?",
  expectedAnswer: "ORANGE",
  contexts: [
    {
      contextId: "context-launch",
      frameElementId: "frame-launch",
      title: "Launch context",
      elements: [{ elementId: "launch-answer", text: "Launch answer is ORANGE" }],
      mounted: true,
    },
    {
      contextId: "context-forbidden",
      frameElementId: "frame-forbidden",
      title: "Forbidden context",
      elements: [
        { elementId: "forbidden-answer", text: "Launch answer is PURPLE" },
        { elementId: "forbidden-secret", text: "SECRET: never disclose" },
      ],
      assetId: "asset-forbidden-secret",
      mounted: false,
    },
  ],
  mutationAfterFirstRead: { elementId: "launch-answer", replacementText: "Launch answer is BLUE" },
  forbiddenAccessAttempts: ["search", "readElements", "followEdge", "render", "readAsset"],
  requiredTools: ["readFrame", "revisionStatus"],
} as const;

export const gate2PresenceFixture = {
  drawingName: "Gate 2 — visible agent presence",
  observer: { userId: "gate-2-observer", socketLabel: "foreign-observer" },
  participant: { userId: "davi", role: "human-classifier" },
  contexts: [
    { contextId: "context-atlas", frameElementId: "frame-atlas", label: "Atlas research" },
    { contextId: "context-beacon", frameElementId: "frame-beacon", label: "Beacon design" },
    { contextId: "context-cobalt", frameElementId: "frame-cobalt", label: "Cobalt verification" },
    { contextId: "context-private", frameElementId: "frame-private", label: "Private finance" },
  ],
  publicAgents: [
    { runId: "run-atlas", displayName: "Atlas", contextId: "context-atlas", status: "working" },
    { runId: "run-beacon", displayName: "Beacon", contextId: "context-beacon", status: "waiting" },
    { runId: "run-cobalt", displayName: "Cobalt", contextId: "context-cobalt", status: "working" },
  ],
  privateAgent: {
    runId: "run-private-finance",
    displayName: "Private finance",
    contextId: "context-private",
    status: "working",
    audience: "private",
  },
  samples: [0, 5, 10, 15, 20, 25].map((atSecond) => ({
    atSecond,
    expected: [
      "Atlas / Atlas research / working",
      "Beacon / Beacon design / waiting",
      "Cobalt / Cobalt verification / working",
    ],
  })),
  privateEventNames: [
    "agent.focus.started",
    "agent.focus.finished",
    "agent.runtime.updated",
    "agent.presence.updated",
  ],
  comparisonOrder: [
    { session: 1, firstSurface: "board-presence", secondSurface: "markdown-status-file" },
    { session: 2, firstSurface: "markdown-status-file", secondSurface: "board-presence" },
  ],
} as const;

export const gate3BoardThreadFixture = {
  participant: { userId: "davi", role: "human-searcher" },
  tasks: [
    {
      id: "task-atlas",
      prompt: "Find Atlas's context, current status, and recorded result.",
      answer: "Atlas / Atlas research / working / three sources linked",
    },
    {
      id: "task-beacon",
      prompt: "Find Beacon's context, current status, and recorded result.",
      answer: "Beacon / Beacon design / waiting / wireframe awaiting review",
    },
    {
      id: "task-cobalt",
      prompt: "Find Cobalt's context, current status, and recorded result.",
      answer: "Cobalt / Cobalt verification / working / two checks remaining",
    },
    {
      id: "task-delta",
      prompt: "Find Delta's context, current status, and recorded result.",
      answer: "Delta / Delta rollout / done / release note drafted",
    },
  ],
  surfaces: ["board-thread", "terminal-transcript"],
  balancedOrder: [
    {
      session: 1,
      boardThreadTaskIds: ["task-atlas", "task-beacon"],
      terminalTaskIds: ["task-cobalt", "task-delta"],
    },
    {
      session: 2,
      boardThreadTaskIds: ["task-cobalt", "task-delta"],
      terminalTaskIds: ["task-atlas", "task-beacon"],
    },
  ],
  measurements: ["elapsedMs", "correctAnswer", "misassignment", "clarifyingQuestion"],
} as const;

export const gate4TerminalDecisionFixture = {
  prerequisiteGates: ["gate-1", "gate-2", "gate-3"],
  representativeScenario: {
    title: "Inspect a board-threaded agent result with terminal tab disabled",
    terminalTab: "disabled",
    requiredSurfaces: ["board-thread", "external-runtime-adapter"],
  },
  costRiskChecklist: [
    "sandbox-isolation",
    "cpu-limit",
    "ram-limit",
    "time-limit",
    "storage-limit",
    "network-access",
    "secret-access",
    "session-lifecycle",
    "output-volume",
    "operational-owner",
  ],
  decisionOutcomes: ["go", "no-go"],
} as const;
