ALTER TABLE "AgentBoardRevision" ADD COLUMN "semanticRelations" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "AgentSemanticRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "fromElementId" TEXT NOT NULL,
    "toElementId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSemanticRelation_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSemanticRelation_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AgentInstructionApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "semanticHash" TEXT NOT NULL,
    "closureHash" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "authority" TEXT NOT NULL DEFAULT 'instruction',
    "approvedRevisionId" TEXT,
    "approvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentInstructionApproval_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentInstructionApproval_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "AgentContext" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentSemanticRelation_contextId_fromElementId_toElementId_kind_key"
ON "AgentSemanticRelation"("contextId", "fromElementId", "toElementId", "kind");
CREATE INDEX "AgentSemanticRelation_drawingId_contextId_createdAt_idx"
ON "AgentSemanticRelation"("drawingId", "contextId", "createdAt");
CREATE UNIQUE INDEX "AgentInstructionApproval_contextId_elementId_key"
ON "AgentInstructionApproval"("contextId", "elementId");
CREATE INDEX "AgentInstructionApproval_drawingId_contextId_approvedAt_idx"
ON "AgentInstructionApproval"("drawingId", "contextId", "approvedAt");
