-- Every page turn receives a per-widget monotonic revision. Clients use it to
-- ignore an older broadcast that arrives after a newer one.
ALTER TABLE "DocumentPageView" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
