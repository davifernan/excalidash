CREATE TABLE "AgentDispatchReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "originThreadId" TEXT NOT NULL,
    "publicThreadId" TEXT NOT NULL,
    "originAudienceKind" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "objectiveSummary" TEXT NOT NULL,
    "targetContextIds" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "effectiveCapabilities" TEXT NOT NULL,
    "budget" TEXT NOT NULL,
    "expectedArtifacts" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "admissionStatus" TEXT NOT NULL DEFAULT 'accepted',
    "executionStatus" TEXT NOT NULL DEFAULT 'queued',
    "effectStatus" TEXT NOT NULL DEFAULT 'pending',
    "runtimeCapability" TEXT,
    "runtimeAcknowledgedAt" DATETIME,
    "lastObservedAt" DATETIME,
    "executionTerminalAt" DATETIME,
    "effectTerminalAt" DATETIME,
    "effectEvidence" TEXT,
    "startDeadlineAt" DATETIME NOT NULL,
    "livenessDeadlineAt" DATETIME NOT NULL,
    "effectDeadlineAt" DATETIME NOT NULL,
    "nextEventSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentDispatchReceipt_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchReceipt_originThreadId_fkey" FOREIGN KEY ("originThreadId") REFERENCES "AgentThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchReceipt_publicThreadId_fkey" FOREIGN KEY ("publicThreadId") REFERENCES "AgentThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRunMount" ("runId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchReceipt_origin_audience_check" CHECK ("originAudienceKind" IN ('private', 'drawing')),
    CONSTRAINT "AgentDispatchReceipt_admission_check" CHECK ("admissionStatus" IN ('accepted', 'rejected')),
    CONSTRAINT "AgentDispatchReceipt_execution_check" CHECK ("executionStatus" IN ('queued', 'runtime_acknowledged', 'running', 'blocked', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')),
    CONSTRAINT "AgentDispatchReceipt_effect_check" CHECK ("effectStatus" IN ('not_requested', 'pending', 'committed', 'rejected', 'failed'))
);

CREATE UNIQUE INDEX "AgentDispatchReceipt_runId_key" ON "AgentDispatchReceipt"("runId");
CREATE INDEX "AgentDispatchReceipt_drawingId_publicThreadId_createdAt_idx" ON "AgentDispatchReceipt"("drawingId", "publicThreadId", "createdAt");
CREATE INDEX "AgentDispatchReceipt_executionStatus_startDeadlineAt_idx" ON "AgentDispatchReceipt"("executionStatus", "startDeadlineAt");
CREATE INDEX "AgentDispatchReceipt_effectStatus_effectDeadlineAt_idx" ON "AgentDispatchReceipt"("effectStatus", "effectDeadlineAt");

CREATE TABLE "AgentDispatchLease" (
    "dispatchId" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "leaseGeneration" TEXT NOT NULL,
    PRIMARY KEY ("dispatchId", "contextId"),
    CONSTRAINT "AgentDispatchLease_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "AgentDispatchReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchLease_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentDispatchLease_contextId_leaseGeneration_idx" ON "AgentDispatchLease"("contextId", "leaseGeneration");

CREATE TABLE "AgentDispatchReceiptEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dispatchId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentDispatchReceiptEvent_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "AgentDispatchReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentDispatchReceiptEvent_dispatchId_sequence_key" ON "AgentDispatchReceiptEvent"("dispatchId", "sequence");
CREATE INDEX "AgentDispatchReceiptEvent_dispatchId_createdAt_idx" ON "AgentDispatchReceiptEvent"("dispatchId", "createdAt");

CREATE TABLE "AgentDispatchOutbox" (
    "dispatchId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "payload" TEXT,
    "attemptStartedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentDispatchOutbox_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "AgentDispatchReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentDispatchOutbox_state_check" CHECK ("state" IN ('pending', 'sending', 'completed', 'failed', 'outcome_unknown'))
);

CREATE INDEX "AgentDispatchOutbox_state_createdAt_idx" ON "AgentDispatchOutbox"("state", "createdAt");
