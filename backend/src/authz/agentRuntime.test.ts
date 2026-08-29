import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeCapabilities } from "./agentRuntime";

const allPolicies = ["agent:read", "agent:run", "agent:prompt", "board:write"];

describe("agent runtime capability intersection", () => {
  it("does not let a delegated request manufacture rights the human lacks", () => {
    expect(
      resolveAgentRuntimeCapabilities({
        access: "view",
        principal: { kind: "user", userId: "viewer" },
        approvedDispatch: allPolicies,
        contextPolicy: allPolicies,
        runtimePolicy: allPolicies,
      }),
    ).toEqual(["agent:read"]);
  });

  it("keeps agent:run independent from board:write for a drawing token", () => {
    expect(
      resolveAgentRuntimeCapabilities({
        access: "edit",
        principal: {
          kind: "user",
          userId: "editor",
          apiKey: { id: "key", scopes: ["agent:run"] },
        },
        approvedDispatch: ["agent:run", "board:write"],
        contextPolicy: ["agent:run", "board:write"],
        runtimePolicy: ["agent:run", "board:write"],
      }),
    ).toEqual(["agent:run"]);
  });

  it("lets every policy independently narrow an otherwise valid grant", () => {
    expect(
      resolveAgentRuntimeCapabilities({
        access: "owner",
        principal: { kind: "user", userId: "owner" },
        approvedDispatch: ["agent:read", "agent:run", "agent:prompt"],
        contextPolicy: ["agent:read", "agent:run"],
        runtimePolicy: ["agent:run", "agent:prompt"],
      }),
    ).toEqual(["agent:run"]);
  });

  it.each([
    ["drawing:read", "board:read"],
    ["drawing:ops", "board:write"],
    ["agent:read", "agent:read"],
    ["agent:run", "agent:run"],
    ["agent:prompt", "agent:prompt"],
    ["artifact:publish", "artifact:publish"],
  ])("maps token scope %s only to capability %s", (scope, capability) => {
    const policies = allPolicies.concat("board:read", "artifact:publish");
    expect(
      resolveAgentRuntimeCapabilities({
        access: "owner",
        principal: { kind: "user", userId: "owner", apiKey: { id: "key", scopes: [scope] } },
        approvedDispatch: policies,
        contextPolicy: policies,
        runtimePolicy: policies,
      }),
    ).toEqual([capability]);
  });

  it("defines terminal scopes without granting them in the 0.15 runtime", () => {
    expect(
      resolveAgentRuntimeCapabilities({
        access: "owner",
        principal: {
          kind: "user",
          userId: "owner",
          apiKey: { id: "key", scopes: ["terminal:read", "terminal:input"] },
        },
        approvedDispatch: ["terminal:read", "terminal:input"],
        contextPolicy: ["terminal:read", "terminal:input"],
        runtimePolicy: ["terminal:read", "terminal:input"],
      }),
    ).toEqual([]);
  });
});
