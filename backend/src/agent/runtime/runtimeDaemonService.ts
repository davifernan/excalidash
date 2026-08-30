import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { runtimeDaemonProfileSchema } from "@excalidash/domain";
import { hashTokenForStorage } from "../../auth/tokenSecurity";
import type { AgentRuntimeCapability, AgentRuntimeProfile } from "./contracts";

type PrismaLike = any;

const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEVICE_TOKEN_PREFIX = "exd_daemon_";
const PAIRING_CODE_PREFIX = "exd_pair_";
const DAEMON_POLICY_CAPABILITIES = ["agent:read", "agent:run", "agent:prompt"] as const;

export class RuntimeDaemonServiceError extends Error {
  constructor(
    public readonly code:
      | "PAIRING_INVALID"
      | "DEVICE_CREDENTIAL_INVALID"
      | "DAEMON_VERSION_INVALID"
      | "DAEMON_VERSION_UNSUPPORTED"
      | "SESSION_FENCED",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDaemonServiceError";
  }
}

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const versionParts = (
  value: string,
): { numbers: [number, number, number]; prerelease: boolean } | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
};

export const assertSupportedDaemonVersion = (version: string, minimum: string): void => {
  const actual = versionParts(version);
  const required = versionParts(minimum);
  if (!actual || !required) {
    throw new RuntimeDaemonServiceError(
      "DAEMON_VERSION_INVALID",
      "The runtime daemon version is not a supported semantic version.",
    );
  }
  for (let index = 0; index < actual.numbers.length; index += 1) {
    if (actual.numbers[index] > required.numbers[index]) return;
    if (actual.numbers[index] < required.numbers[index]) {
      throw new RuntimeDaemonServiceError(
        "DAEMON_VERSION_UNSUPPORTED",
        `Runtime daemon ${version} is too old. Install version ${minimum} or newer.`,
      );
    }
  }
  if (actual.prerelease && !required.prerelease) {
    throw new RuntimeDaemonServiceError(
      "DAEMON_VERSION_UNSUPPORTED",
      `Runtime daemon ${version} is too old. Install version ${minimum} or newer.`,
    );
  }
};

const parseDeviceId = (credential: string): string | null => {
  if (!credential.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const remainder = credential.slice(DEVICE_TOKEN_PREFIX.length);
  const separator = remainder.indexOf("_");
  if (separator <= 0) return null;
  const id = remainder.slice(0, separator);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

const parseJsonArray = <T>(value: string): T[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const parseJsonValue = (value: string | null | undefined): unknown | null => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export type AuthenticatedRuntimeDaemon = {
  id: string;
  ownerUserId: string;
  label: string;
  daemonVersion: string;
  profiles: AgentRuntimeProfile[];
  policyCapabilities: AgentRuntimeCapability[];
  costBearerLabel: string;
  planLabel: string | null;
  limits: unknown | null;
  sessionEpoch: number;
};

const toAuthenticatedDaemon = (row: any): AuthenticatedRuntimeDaemon => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  label: row.label,
  daemonVersion: row.daemonVersion,
  profiles: parseJsonArray<unknown>(row.profiles).flatMap((profile) => {
    const parsed = runtimeDaemonProfileSchema.safeParse(profile);
    return parsed.success ? [parsed.data] : [];
  }),
  policyCapabilities: parseJsonArray<AgentRuntimeCapability>(row.policyCapabilities).filter(
    (capability): capability is AgentRuntimeCapability =>
      (DAEMON_POLICY_CAPABILITIES as readonly string[]).includes(capability),
  ),
  costBearerLabel: row.costBearerLabel,
  planLabel: row.planLabel ?? null,
  limits: parseJsonValue(row.limits),
  sessionEpoch: row.sessionEpoch,
});

export class RuntimeDaemonService {
  constructor(
    private readonly prisma: PrismaLike,
    readonly minimumVersion: string,
  ) {}

  async createPairing(params: { ownerUserId: string; label: string; now?: Date }) {
    const now = params.now ?? new Date();
    const pairingCode = `${PAIRING_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
    const pairing = await this.prisma.agentRuntimePairing.create({
      data: {
        ownerUserId: params.ownerUserId,
        label: params.label,
        codeHash: hashTokenForStorage(pairingCode),
        expiresAt: new Date(now.getTime() + PAIRING_TTL_MS),
      },
      select: { id: true, expiresAt: true },
    });
    return { pairingId: pairing.id, pairingCode, expiresAt: pairing.expiresAt.toISOString() };
  }

  async exchangePairing(params: {
    pairingCode: string;
    daemonVersion: string;
    profiles: readonly AgentRuntimeProfile[];
    planLabel?: string | null;
    limits?: unknown | null;
    now?: Date;
  }) {
    assertSupportedDaemonVersion(params.daemonVersion, this.minimumVersion);
    const profiles = params.profiles.map((profile) => runtimeDaemonProfileSchema.parse(profile));
    const now = params.now ?? new Date();
    const credentialHashInput = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    const credential = `${DEVICE_TOKEN_PREFIX}${deviceId}_${credentialHashInput}`;
    const codeHash = hashTokenForStorage(params.pairingCode);

    const daemon = await this.prisma.$transaction(async (tx: PrismaLike) => {
      const pairing = await tx.agentRuntimePairing.findUnique({
        where: { codeHash },
        include: { owner: { select: { name: true } } },
      });
      if (!pairing || pairing.consumedAt || pairing.expiresAt <= now) {
        throw new RuntimeDaemonServiceError(
          "PAIRING_INVALID",
          "The pairing code is invalid, expired, or already used.",
        );
      }
      const consumed = await tx.agentRuntimePairing.updateMany({
        where: { id: pairing.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new RuntimeDaemonServiceError(
          "PAIRING_INVALID",
          "The pairing code is invalid, expired, or already used.",
        );
      }
      return tx.agentRuntimeDaemon.create({
        data: {
          id: deviceId,
          ownerUserId: pairing.ownerUserId,
          label: pairing.label,
          credentialHash: hashTokenForStorage(credential),
          daemonVersion: params.daemonVersion,
          profiles: JSON.stringify(profiles),
          policyCapabilities: JSON.stringify(DAEMON_POLICY_CAPABILITIES),
          costBearerLabel: pairing.owner.name,
          planLabel: params.planLabel?.trim() || null,
          limits: params.limits == null ? null : JSON.stringify(params.limits),
        },
      });
    });
    return { credential, daemon: toAuthenticatedDaemon(daemon) };
  }

  async authenticate(credential: string): Promise<AuthenticatedRuntimeDaemon> {
    const deviceId = parseDeviceId(credential);
    if (!deviceId) {
      throw new RuntimeDaemonServiceError(
        "DEVICE_CREDENTIAL_INVALID",
        "The runtime daemon credential is invalid or revoked.",
      );
    }
    const row = await this.prisma.agentRuntimeDaemon.findUnique({ where: { id: deviceId } });
    if (!row || row.revokedAt || !safeEqual(hashTokenForStorage(credential), row.credentialHash)) {
      throw new RuntimeDaemonServiceError(
        "DEVICE_CREDENTIAL_INVALID",
        "The runtime daemon credential is invalid or revoked.",
      );
    }
    return toAuthenticatedDaemon(row);
  }

  async openSession(params: {
    credential: string;
    daemonVersion: string;
    profiles: readonly AgentRuntimeProfile[];
    planLabel?: string | null;
    limits?: unknown | null;
    now?: Date;
  }): Promise<AuthenticatedRuntimeDaemon> {
    const current = await this.authenticate(params.credential);
    assertSupportedDaemonVersion(params.daemonVersion, this.minimumVersion);
    const profiles = params.profiles.map((profile) => runtimeDaemonProfileSchema.parse(profile));
    const now = params.now ?? new Date();
    const expectedEpoch = current.sessionEpoch + 1;
    const updated = await this.prisma.agentRuntimeDaemon.updateMany({
      where: {
        id: current.id,
        sessionEpoch: current.sessionEpoch,
        revokedAt: null,
      },
      data: {
        daemonVersion: params.daemonVersion,
        profiles: JSON.stringify(profiles),
        planLabel: params.planLabel?.trim() || null,
        limits: params.limits == null ? null : JSON.stringify(params.limits),
        sessionEpoch: { increment: 1 },
        lastSeenAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new RuntimeDaemonServiceError(
        "SESSION_FENCED",
        "A newer runtime daemon session replaced this connection attempt.",
      );
    }
    return {
      ...current,
      daemonVersion: params.daemonVersion,
      profiles,
      planLabel: params.planLabel?.trim() || null,
      limits: params.limits ?? null,
      sessionEpoch: expectedEpoch,
    };
  }

  async touchSession(params: {
    credential: string;
    epoch: number;
    now?: Date;
  }): Promise<AuthenticatedRuntimeDaemon> {
    const daemon = await this.authenticate(params.credential);
    if (daemon.sessionEpoch !== params.epoch) {
      throw new RuntimeDaemonServiceError(
        "SESSION_FENCED",
        "This runtime daemon session has been replaced by a newer connection.",
      );
    }
    const updated = await this.prisma.agentRuntimeDaemon.updateMany({
      where: { id: daemon.id, sessionEpoch: params.epoch, revokedAt: null },
      data: { lastSeenAt: params.now ?? new Date() },
    });
    if (updated.count !== 1) {
      throw new RuntimeDaemonServiceError(
        "SESSION_FENCED",
        "This runtime daemon session has been replaced by a newer connection.",
      );
    }
    return daemon;
  }

  async list(ownerUserId: string) {
    const rows = await this.prisma.agentRuntimeDaemon.findMany({
      where: { ownerUserId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row: any) => ({
      id: row.id,
      label: row.label,
      daemonVersion: row.daemonVersion,
      planLabel: row.planLabel,
      limits: parseJsonValue(row.limits),
      revoked: Boolean(row.revokedAt),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async revoke(ownerUserId: string, daemonId: string, now = new Date()): Promise<boolean> {
    const updated = await this.prisma.agentRuntimeDaemon.updateMany({
      where: { id: daemonId, ownerUserId, revokedAt: null },
      data: { revokedAt: now, sessionEpoch: { increment: 1 } },
    });
    return updated.count === 1;
  }
}

export const runtimeDaemonCredentialFromRequest = (authorization: unknown): string | null => {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof value !== "string") return null;
  const [scheme, credential] = value.split(" ");
  return scheme === "Bearer" && credential?.startsWith(DEVICE_TOKEN_PREFIX) ? credential : null;
};
