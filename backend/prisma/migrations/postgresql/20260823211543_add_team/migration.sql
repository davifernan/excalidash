-- The team this instance serves. A singleton, like SystemConfig: one row,
-- one self-hosted install, one team. Seeded here so every reader can assume
-- it exists instead of lazily creating it on first read.
CREATE TABLE "Team" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'Team',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Team" ("id", "name", "createdAt", "updatedAt")
VALUES ('default', 'Team', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
