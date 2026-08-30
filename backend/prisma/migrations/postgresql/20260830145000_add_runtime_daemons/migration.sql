CREATE TABLE "AgentRuntimeDaemon" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "daemonVersion" TEXT NOT NULL,
    "profiles" TEXT NOT NULL,
    "policyCapabilities" TEXT NOT NULL,
    "costBearerLabel" TEXT NOT NULL,
    "planLabel" TEXT,
    "limits" TEXT,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRuntimeDaemon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRuntimeDaemon_credentialHash_key" ON "AgentRuntimeDaemon"("credentialHash");
CREATE INDEX "AgentRuntimeDaemon_ownerUserId_revokedAt_idx" ON "AgentRuntimeDaemon"("ownerUserId", "revokedAt");

CREATE TABLE "AgentRuntimePairing" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRuntimePairing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRuntimePairing_codeHash_key" ON "AgentRuntimePairing"("codeHash");
CREATE INDEX "AgentRuntimePairing_ownerUserId_expiresAt_idx" ON "AgentRuntimePairing"("ownerUserId", "expiresAt");

ALTER TABLE "AgentRuntimeDaemon" ADD CONSTRAINT "AgentRuntimeDaemon_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRuntimePairing" ADD CONSTRAINT "AgentRuntimePairing_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
