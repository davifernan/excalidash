CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "drawingId" TEXT NOT NULL,
    "threadKind" TEXT NOT NULL,
    "audienceKind" TEXT NOT NULL,
    "audienceUserId" TEXT,
    "contextId" TEXT,
    "anchorElementId" TEXT,
    "title" TEXT NOT NULL,
    "anchorX" DOUBLE PRECISION,
    "anchorY" DOUBLE PRECISION,
    "nextEventSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentThread_kind_check" CHECK ("threadKind" IN ('context', 'orchestrator')),
    CONSTRAINT "AgentThread_audience_check" CHECK (
      ("audienceKind" = 'private' AND "audienceUserId" IS NOT NULL) OR
      ("audienceKind" = 'drawing' AND "audienceUserId" IS NULL)
    ),
    CONSTRAINT "AgentThread_shape_check" CHECK (
      ("threadKind" = 'context' AND "contextId" IS NOT NULL AND "anchorElementId" IS NULL AND "audienceKind" = 'drawing') OR
      ("threadKind" = 'orchestrator' AND "contextId" IS NULL)
    )
);

CREATE UNIQUE INDEX "AgentThread_contextId_key" ON "AgentThread"("contextId");
CREATE UNIQUE INDEX "AgentThread_drawingId_threadKind_audienceUserId_key" ON "AgentThread"("drawingId", "threadKind", "audienceUserId");
CREATE UNIQUE INDEX "AgentThread_drawingId_anchorElementId_key" ON "AgentThread"("drawingId", "anchorElementId");
CREATE INDEX "AgentThread_drawingId_audienceKind_createdAt_idx" ON "AgentThread"("drawingId", "audienceKind", "createdAt");
CREATE INDEX "AgentThread_audienceUserId_updatedAt_idx" ON "AgentThread"("audienceUserId", "updatedAt");

ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "AgentThread" (
    "id", "drawingId", "threadKind", "audienceKind", "contextId", "title",
    "nextEventSequence", "createdAt", "updatedAt"
)
SELECT
    "id", "drawingId", 'context', 'drawing', "id", 'Context thread',
    "nextEventSequence", "createdAt", "updatedAt"
FROM "AgentContext";

CREATE TABLE "AgentThreadEvent" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "actorDisplayName" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentThreadEvent_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AgentThreadEvent" (
    "id", "threadId", "sequence", "actorKind", "actorId",
    "actorDisplayName", "eventKind", "payload", "createdAt"
)
SELECT
    "id", "contextId", "sequence", "actorKind", "actorId",
    "actorDisplayName", "eventKind", "payload", "createdAt"
FROM "AgentContextEvent";

CREATE UNIQUE INDEX "AgentThreadEvent_threadId_sequence_key" ON "AgentThreadEvent"("threadId", "sequence");
CREATE INDEX "AgentThreadEvent_threadId_createdAt_idx" ON "AgentThreadEvent"("threadId", "createdAt");
ALTER TABLE "AgentThreadEvent" ADD CONSTRAINT "AgentThreadEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "AgentContextEvent";
ALTER TABLE "AgentContext" DROP COLUMN "nextEventSequence";
