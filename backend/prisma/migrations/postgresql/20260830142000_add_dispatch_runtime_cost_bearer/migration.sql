ALTER TABLE "AgentDispatchReceipt"
  ADD COLUMN "runtimeConnectionId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "costBearerOwnerKind" TEXT NOT NULL DEFAULT 'operator',
  ADD COLUMN "costBearerOwnerId" TEXT NOT NULL DEFAULT 'installation',
  ADD COLUMN "costBearerLabel" TEXT NOT NULL DEFAULT 'Instance operator',
  ADD COLUMN "executionReasonCode" TEXT;
