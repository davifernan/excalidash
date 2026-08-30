import type { AgentRuntimeConfig } from "../../config";
import { AgentRuntimeGateway } from "./gateway";
import { HerdrAgentRuntimeAdapter } from "./herdrAdapter";
import { AgentRuntimeRegistry } from "./registry";
import { OutboundRuntimeDaemonAdapter } from "./runtimeDaemonAdapter";
import type { RuntimeDaemonBroker } from "./runtimeDaemonBroker";

export const createConfiguredAgentRuntimeGateway = (
  config: AgentRuntimeConfig,
  capabilitySecret: string,
  daemonBroker?: RuntimeDaemonBroker,
): AgentRuntimeGateway => {
  const adapter = new HerdrAgentRuntimeAdapter();
  const daemonAdapter = daemonBroker ? new OutboundRuntimeDaemonAdapter(daemonBroker) : null;
  const connections = config.herdr
    ? [
        {
          id: "herdr-local",
          label: "Herdr",
          adapterId: adapter.id,
          audience: { kind: "installation" as const },
          profiles: config.herdr.profiles.map(({ id, label }) => ({ id, label })),
          policyCapabilities: ["agent:read", "agent:run", "agent:prompt"] as const,
          costBearer: {
            ownerKind: "operator" as const,
            ownerId: config.herdr.operatorId,
            label: config.herdr.operatorLabel,
          },
          adapterConfig: config.herdr,
        },
      ]
    : [];
  return new AgentRuntimeGateway(
    new AgentRuntimeRegistry({
      adapters: daemonAdapter ? [adapter, daemonAdapter] : [adapter],
      connections,
      sources: daemonBroker ? [daemonBroker] : [],
    }),
    capabilitySecret,
  );
};
