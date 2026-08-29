import type { AgentRuntimeConfig } from "../../config";
import { AgentRuntimeGateway } from "./gateway";
import { HerdrAgentRuntimeAdapter } from "./herdrAdapter";
import { AgentRuntimeRegistry } from "./registry";

export const createConfiguredAgentRuntimeGateway = (
  config: AgentRuntimeConfig,
  capabilitySecret: string,
): AgentRuntimeGateway => {
  const adapter = new HerdrAgentRuntimeAdapter();
  const connections = config.herdr
    ? [
        {
          id: "herdr-local",
          label: "Herdr",
          adapterId: adapter.id,
          audience: { kind: "installation" as const },
          profiles: config.herdr.profiles.map(({ id, label }) => ({ id, label })),
          policyCapabilities: ["agent:read", "agent:run", "agent:prompt"] as const,
          adapterConfig: config.herdr,
        },
      ]
    : [];
  return new AgentRuntimeGateway(
    new AgentRuntimeRegistry({ adapters: [adapter], connections }),
    capabilitySecret,
  );
};
