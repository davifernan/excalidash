-- A delayed join snapshot must not overwrite a newer live name broadcast.
ALTER TABLE "Drawing" ADD COLUMN "nameRevision" INTEGER NOT NULL DEFAULT 1;
