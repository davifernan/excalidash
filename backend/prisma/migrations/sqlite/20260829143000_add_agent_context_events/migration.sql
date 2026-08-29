ALTER TABLE "AgentContext" ADD COLUMN "nextEventSequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AgentContextEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contextId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "actorDisplayName" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentContextEvent_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentContextEvent_contextId_sequence_key" ON "AgentContextEvent"("contextId", "sequence");
CREATE INDEX "AgentContextEvent_contextId_createdAt_idx" ON "AgentContextEvent"("contextId", "createdAt");
