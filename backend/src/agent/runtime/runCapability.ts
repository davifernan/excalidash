import crypto from "crypto";
import {
  AGENT_RUNTIME_CAPABILITIES,
  AgentRuntimeError,
  type AgentRuntimeCapability,
} from "./contracts";

const PREFIX = "exd_run_";
const VERSION = 1;
export const RUN_CAPABILITY_TTL_MS = 8 * 60 * 60 * 1000;

export type AgentRunCapabilityClaims = {
  v: 1;
  runId: string;
  drawingId: string;
  connectionId: string;
  runtimeHandle: string;
  subject: string;
  capabilities: AgentRuntimeCapability[];
  issuedAt: number;
  expiresAt: number;
};

const capabilityKey = (secret: string): Buffer =>
  crypto
    .createHash("sha256")
    .update("excalidash:agent-run-capability:v1\0")
    .update(secret)
    .digest();

const encrypt = (secret: string, claims: AgentRunCapabilityClaims): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", capabilityKey(secret), iv);
  cipher.setAAD(Buffer.from(PREFIX, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
};

export const issueAgentRunCapability = (params: {
  secret: string;
  runId: string;
  drawingId: string;
  connectionId: string;
  runtimeHandle: string;
  subject: string;
  capabilities: AgentRuntimeCapability[];
  now?: Date;
  ttlMs?: number;
}): { token: string; claims: AgentRunCapabilityClaims } => {
  const issuedAt = (params.now ?? new Date()).getTime();
  const claims: AgentRunCapabilityClaims = {
    v: VERSION,
    runId: params.runId,
    drawingId: params.drawingId,
    connectionId: params.connectionId,
    runtimeHandle: params.runtimeHandle,
    subject: params.subject,
    capabilities: [...new Set(params.capabilities)],
    issuedAt,
    expiresAt: issuedAt + (params.ttlMs ?? RUN_CAPABILITY_TTL_MS),
  };
  return { token: `${PREFIX}${encrypt(params.secret, claims)}`, claims };
};

const isClaims = (input: unknown): input is AgentRunCapabilityClaims => {
  if (!input || typeof input !== "object") return false;
  const claims = input as Record<string, unknown>;
  return (
    claims.v === VERSION &&
    typeof claims.runId === "string" &&
    typeof claims.drawingId === "string" &&
    typeof claims.connectionId === "string" &&
    typeof claims.runtimeHandle === "string" &&
    typeof claims.subject === "string" &&
    typeof claims.issuedAt === "number" &&
    Number.isSafeInteger(claims.issuedAt) &&
    typeof claims.expiresAt === "number" &&
    Number.isSafeInteger(claims.expiresAt) &&
    claims.expiresAt > claims.issuedAt &&
    Array.isArray(claims.capabilities) &&
    claims.capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        (AGENT_RUNTIME_CAPABILITIES as readonly string[]).includes(capability),
    )
  );
};

export const verifyAgentRunCapability = (params: {
  secret: string;
  token: string;
  drawingId: string;
  subject: string;
  requiredCapability: AgentRuntimeCapability;
  now?: Date;
}): AgentRunCapabilityClaims => {
  if (!params.token.startsWith(PREFIX) || params.token.length > 16_384) {
    throw new AgentRuntimeError("RUN_CAPABILITY_INVALID", "Run capability is invalid.");
  }
  let claims: unknown;
  try {
    const parts = params.token.slice(PREFIX.length).split(".");
    if (parts.length !== 3) throw new Error("invalid envelope");
    const [iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid envelope");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", capabilityKey(params.secret), iv);
    decipher.setAAD(Buffer.from(PREFIX, "utf8"));
    decipher.setAuthTag(tag);
    claims = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    );
  } catch {
    throw new AgentRuntimeError("RUN_CAPABILITY_INVALID", "Run capability is invalid.");
  }
  if (!isClaims(claims)) {
    throw new AgentRuntimeError("RUN_CAPABILITY_INVALID", "Run capability is invalid.");
  }
  if (claims.expiresAt <= (params.now ?? new Date()).getTime()) {
    throw new AgentRuntimeError("RUN_CAPABILITY_EXPIRED", "Run capability has expired.");
  }
  if (
    claims.drawingId !== params.drawingId ||
    claims.subject !== params.subject ||
    !claims.capabilities.includes(params.requiredCapability)
  ) {
    throw new AgentRuntimeError(
      "RUN_CAPABILITY_FORBIDDEN",
      "Run capability does not grant this action.",
    );
  }
  return claims;
};
