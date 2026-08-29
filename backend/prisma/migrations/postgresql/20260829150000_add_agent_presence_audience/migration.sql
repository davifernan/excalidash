ALTER TABLE "AgentRunMount" ADD COLUMN "displayName" TEXT NOT NULL DEFAULT 'Agent';
ALTER TABLE "AgentRunMount" ADD COLUMN "audienceKind" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "AgentRunMount" ADD COLUMN "audienceUserId" TEXT;
