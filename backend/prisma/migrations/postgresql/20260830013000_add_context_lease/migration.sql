CREATE TABLE "ContextLease" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "leaseGeneration" TEXT NOT NULL,
    "holderOrchestratorId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endHorizonAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContextLease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContextLeaseEvent" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holderOrchestratorId" TEXT,
    "initiatedByUserId" TEXT,
    "runId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextLeaseEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContextLease_contextId_key" ON "ContextLease"("contextId");
CREATE INDEX "ContextLease_contextId_expiresAt_idx" ON "ContextLease"("contextId", "expiresAt");
CREATE INDEX "ContextLeaseEvent_contextId_createdAt_idx" ON "ContextLeaseEvent"("contextId", "createdAt");

ALTER TABLE "ContextLease" ADD CONSTRAINT "ContextLease_contextId_fkey"
FOREIGN KEY ("contextId") REFERENCES "AgentContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContextLeaseEvent" ADD CONSTRAINT "ContextLeaseEvent_contextId_fkey"
FOREIGN KEY ("contextId") REFERENCES "AgentContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;
