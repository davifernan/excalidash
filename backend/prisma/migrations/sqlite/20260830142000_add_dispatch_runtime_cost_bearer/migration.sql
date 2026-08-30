ALTER TABLE "AgentDispatchReceipt" ADD COLUMN "runtimeConnectionId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AgentDispatchReceipt" ADD COLUMN "costBearerOwnerKind" TEXT NOT NULL DEFAULT 'operator';
ALTER TABLE "AgentDispatchReceipt" ADD COLUMN "costBearerOwnerId" TEXT NOT NULL DEFAULT 'installation';
ALTER TABLE "AgentDispatchReceipt" ADD COLUMN "costBearerLabel" TEXT NOT NULL DEFAULT 'Instance operator';
ALTER TABLE "AgentDispatchReceipt" ADD COLUMN "executionReasonCode" TEXT;
