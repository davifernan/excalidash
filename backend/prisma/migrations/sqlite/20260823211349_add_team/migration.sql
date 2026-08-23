-- The team this instance serves. A singleton, like SystemConfig: one row,
-- one self-hosted install, one team. Seeded here so every reader can assume
-- it exists instead of lazily creating it on first read.
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'Team',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "Team" ("id", "name", "createdAt", "updatedAt")
VALUES ('default', 'Team', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
