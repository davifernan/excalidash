import crypto from "crypto";
import type { DrawingAccess, DrawingPrincipal } from "../../authz/sharing";
import { resolveAgentRuntimeCapabilities, runtimeSubject } from "../../authz/agentRuntime";
import {
  AgentRuntimeError,
  type AgentRuntimeCapability,
  type RuntimeStartInput,
  type RuntimeStatusEvent,
  type RuntimeSubscription,
} from "./contracts";
import { AgentRuntimeRegistry } from "./registry";
import { issueAgentRunCapability, verifyAgentRunCapability } from "./runCapability";

const CONTEXT_POLICY = [
  "board:read",
  "agent:read",
  "agent:run",
  "agent:prompt",
  "artifact:publish",
  "board:write",
] as const satisfies readonly AgentRuntimeCapability[];

export class AgentRuntimeGateway {
  constructor(
    private readonly registry: AgentRuntimeRegistry,
    private readonly capabilitySecret: string,
  ) {}

  async connections(userId: string) {
    return Promise.all(
      this.registry.listConnections(userId).map(async (connection) => ({
        id: connection.id,
        label: connection.label,
        audience: { kind: connection.audience.kind },
        profiles: connection.profiles,
        health: await this.registry
          .resolve(connection.id, userId)
          .adapter.health(connection)
          .catch(() => ({ connected: false, status: "disconnected" as const })),
      })),
    );
  }

  /**
   * Resolve the exact capability intersection without contacting the foreign
   * runtime. DispatchReceipt persists this result before its outbox crosses
   * the runtime boundary, so the public promise cannot be wider than the run
   * that is subsequently started.
   */
  planStart(params: {
    access: DrawingAccess;
    principal: DrawingPrincipal;
    connectionId: string;
    profileId: string;
    approvedCapabilities: readonly string[];
  }): { effectiveCapabilities: AgentRuntimeCapability[] } {
    const resolved = this.registry.resolve(params.connectionId, params.principal.userId);
    if (!resolved.connection.profiles.some((profile) => profile.id === params.profileId)) {
      throw new AgentRuntimeError(
        "RUNTIME_PROFILE_NOT_FOUND",
        "The selected runtime profile is not available.",
      );
    }
    const effectiveCapabilities = resolveAgentRuntimeCapabilities({
      access: params.access,
      principal: params.principal,
      approvedDispatch: params.approvedCapabilities,
      contextPolicy: CONTEXT_POLICY,
      runtimePolicy: resolved.connection.policyCapabilities,
    });
    if (!effectiveCapabilities.includes("agent:run")) {
      throw new AgentRuntimeError(
        "RUN_CAPABILITY_FORBIDDEN",
        "The effective capability set does not grant agent:run.",
      );
    }
    return { effectiveCapabilities };
  }

  async start(params: {
    drawingId: string;
    access: DrawingAccess;
    principal: DrawingPrincipal;
    connectionId: string;
    profileId: string;
    displayName: string;
    initialPrompt?: string;
    approvedCapabilities: readonly string[];
    runId?: string;
    dispatchId?: string;
    boardMount?: RuntimeStartInput["boardMount"];
  }) {
    const resolved = this.registry.resolve(params.connectionId, params.principal.userId);
    const { effectiveCapabilities: capabilities } = this.planStart(params);

    const runId = params.runId ?? crypto.randomUUID();
    const runtimeRun = await resolved.adapter.start(resolved.connection, {
      profileId: params.profileId,
      displayName: params.displayName,
      initialPrompt: params.initialPrompt,
      runId,
      drawingId: params.drawingId,
      dispatchId: params.dispatchId,
      boardMount: params.boardMount,
    });
    const issued = issueAgentRunCapability({
      secret: this.capabilitySecret,
      runId,
      drawingId: params.drawingId,
      connectionId: resolved.connection.id,
      runtimeHandle: runtimeRun.handle,
      subject: runtimeSubject(params.principal),
      capabilities,
    });
    return {
      run: {
        id: runId,
        displayName: runtimeRun.displayName,
        status: runtimeRun.status,
        capabilities,
      },
      runCapability: issued.token,
      expiresAt: new Date(issued.claims.expiresAt).toISOString(),
    };
  }

  private resolveRun(params: {
    drawingId: string;
    access: DrawingAccess;
    principal: DrawingPrincipal;
    runCapability: string;
    requiredCapability: AgentRuntimeCapability;
  }) {
    const claims = verifyAgentRunCapability({
      secret: this.capabilitySecret,
      token: params.runCapability,
      drawingId: params.drawingId,
      subject: runtimeSubject(params.principal),
      requiredCapability: params.requiredCapability,
    });
    const resolved = this.registry.resolve(claims.connectionId, params.principal.userId);
    const stillEffective = resolveAgentRuntimeCapabilities({
      access: params.access,
      principal: params.principal,
      approvedDispatch: claims.capabilities,
      contextPolicy: CONTEXT_POLICY,
      runtimePolicy: resolved.connection.policyCapabilities,
    });
    if (!stillEffective.includes(params.requiredCapability)) {
      throw new AgentRuntimeError(
        "RUN_CAPABILITY_FORBIDDEN",
        "Current board rights no longer grant this run action.",
      );
    }
    return {
      claims,
      ...resolved,
    };
  }

  assertRunCapability(
    params: {
      drawingId: string;
      access: DrawingAccess;
      principal: DrawingPrincipal;
      runCapability: string;
    },
    requiredCapability: AgentRuntimeCapability,
  ): void {
    this.resolveRun({ ...params, requiredCapability });
  }

  async status(params: {
    drawingId: string;
    access: DrawingAccess;
    principal: DrawingPrincipal;
    runCapability: string;
  }): Promise<{ id: string } & RuntimeStatusEvent> {
    const resolved = this.resolveRun({ ...params, requiredCapability: "agent:read" });
    return {
      id: resolved.claims.runId,
      ...(await resolved.adapter.status(resolved.connection, resolved.claims.runtimeHandle)),
    };
  }

  async prompt(params: {
    drawingId: string;
    access: DrawingAccess;
    principal: DrawingPrincipal;
    runCapability: string;
    text: string;
  }): Promise<{ id: string } & RuntimeStatusEvent> {
    const resolved = this.resolveRun({ ...params, requiredCapability: "agent:prompt" });
    return {
      id: resolved.claims.runId,
      ...(await resolved.adapter.prompt(
        resolved.connection,
        resolved.claims.runtimeHandle,
        params.text,
      )),
    };
  }

  async subscribe(
    params: {
      drawingId: string;
      access: DrawingAccess;
      principal: DrawingPrincipal;
      runCapability: string;
    },
    listener: (event: { id: string } & RuntimeStatusEvent) => void,
  ): Promise<RuntimeSubscription> {
    const resolved = this.resolveRun({ ...params, requiredCapability: "agent:read" });
    return resolved.adapter.subscribe(resolved.connection, resolved.claims.runtimeHandle, (event) =>
      listener({ id: resolved.claims.runId, ...event }),
    );
  }
}
