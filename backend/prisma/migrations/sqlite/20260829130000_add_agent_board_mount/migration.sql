CREATE TABLE "AgentContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "frameElementId" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentContext_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AgentBoardRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "sourceDrawingVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "elements" TEXT NOT NULL,
    "appState" TEXT NOT NULL,
    "files" TEXT NOT NULL,
    "contextMap" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentBoardRevision_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AgentRunMount" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "allowedContextIds" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL,
    "capabilityTokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunMount_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRunMount_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentBoardRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AgentToolAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "resultHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentToolAudit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRunMount" ("runId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentToolAudit_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentBoardRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AgentBoardRevisionAsset" (
    "revisionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    PRIMARY KEY ("revisionId", "assetId"),
    CONSTRAINT "AgentBoardRevisionAsset_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "AgentBoardRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentBoardRevisionAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentContext_drawingId_frameElementId_key" ON "AgentContext"("drawingId", "frameElementId");
CREATE INDEX "AgentContext_drawingId_createdAt_idx" ON "AgentContext"("drawingId", "createdAt");
CREATE UNIQUE INDEX "AgentBoardRevision_drawingId_contentHash_key" ON "AgentBoardRevision"("drawingId", "contentHash");
CREATE INDEX "AgentBoardRevision_drawingId_createdAt_idx" ON "AgentBoardRevision"("drawingId", "createdAt");
CREATE UNIQUE INDEX "AgentRunMount_capabilityTokenHash_key" ON "AgentRunMount"("capabilityTokenHash");
CREATE INDEX "AgentRunMount_drawingId_createdAt_idx" ON "AgentRunMount"("drawingId", "createdAt");
CREATE INDEX "AgentRunMount_revisionId_idx" ON "AgentRunMount"("revisionId");
CREATE INDEX "AgentToolAudit_runId_createdAt_idx" ON "AgentToolAudit"("runId", "createdAt");
CREATE INDEX "AgentToolAudit_revisionId_idx" ON "AgentToolAudit"("revisionId");
CREATE INDEX "AgentBoardRevisionAsset_assetId_idx" ON "AgentBoardRevisionAsset"("assetId");
