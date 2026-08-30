CREATE TABLE "ContextLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextId" TEXT NOT NULL,
    "leaseGeneration" TEXT NOT NULL,
    "holderOrchestratorId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "endHorizonAt" DATETIME NOT NULL,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContextLease_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ContextLeaseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holderOrchestratorId" TEXT,
    "initiatedByUserId" TEXT,
    "runId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextLeaseEvent_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ContextLease_contextId_key" ON "ContextLease"("contextId");
CREATE INDEX "ContextLease_contextId_expiresAt_idx" ON "ContextLease"("contextId", "expiresAt");
CREATE INDEX "ContextLeaseEvent_contextId_createdAt_idx" ON "ContextLeaseEvent"("contextId", "createdAt");
