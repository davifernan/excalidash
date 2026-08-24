-- AlterTable
ALTER TABLE "Drawing" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Drawing" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "Drawing_archivedAt_idx" ON "Drawing"("archivedAt");

-- CreateTable
CREATE TABLE "LibraryItem" (
    "id" TEXT NOT NULL,
    "excalidrawItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'personal',
    "ownerUserId" TEXT NOT NULL,
    "excalidrawData" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryItem_visibility_category_idx" ON "LibraryItem"("visibility", "category");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryItem_ownerUserId_excalidrawItemId_key" ON "LibraryItem"("ownerUserId", "excalidrawItemId");

-- AddForeignKey
ALTER TABLE "LibraryItem" ADD CONSTRAINT "LibraryItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration: same one-time move described in the sqlite migration in
-- this pair -- every existing per-account `Library` blob's `items` array
-- becomes one "personal"-visibility `LibraryItem` row per item, owned by
-- the same account. Row-by-row with its own exception handler (rather than
-- one `jsonb_array_elements` over the whole table) so a single malformed
-- historical `items` blob is skipped, not a reason for every self-hosted
-- install's upgrade to fail outright.
DO $$
DECLARE
  lib RECORD;
  item JSONB;
  owner_id TEXT;
BEGIN
  FOR lib IN SELECT id, items, "createdAt", "updatedAt" FROM "Library" WHERE id LIKE 'user\_%' ESCAPE '\' LOOP
    owner_id := substr(lib.id, 6);
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = owner_id) THEN
      CONTINUE;
    END IF;
    BEGIN
      FOR item IN SELECT value FROM jsonb_array_elements(lib.items::jsonb) LOOP
        BEGIN
          INSERT INTO "LibraryItem"
            ("id", "excalidrawItemId", "name", "category", "visibility", "ownerUserId", "excalidrawData", "createdAt", "updatedAt")
          VALUES (
            'mig-' || md5(random()::text || clock_timestamp()::text),
            COALESCE(item->>'id', 'mig-item-' || md5(random()::text)),
            COALESCE(item->>'name', 'Imported item'),
            NULL,
            'personal',
            owner_id,
            item::text,
            lib."createdAt",
            lib."updatedAt"
          )
          ON CONFLICT ("ownerUserId", "excalidrawItemId") DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
          -- One malformed item does not lose the rest of this account's library.
          NULL;
        END;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      -- `items` was not valid JSON on this row -- skip the whole row.
      NULL;
    END;
  END LOOP;
END $$;

-- DropTable
DROP TABLE "Library";

-- DataMigration: backfill NIL-363's search text for every board that
-- existed before this column did, same guard shape as above -- a board
-- with corrupt `elements` (should not occur; every writer JSON.stringifies
-- it) falls back to name-only search rather than failing the migration.
DO $$
DECLARE
  d RECORD;
  txt TEXT;
BEGIN
  FOR d IN SELECT id, name, elements FROM "Drawing" LOOP
    BEGIN
      SELECT string_agg(el->>'text', ' ')
      INTO txt
      FROM jsonb_array_elements(d.elements::jsonb) AS el
      WHERE el->>'type' = 'text'
        AND (el->>'isDeleted' IS NULL OR el->>'isDeleted' = 'false')
        AND el->>'text' IS NOT NULL;

      UPDATE "Drawing"
      SET "searchText" = lower(trim(both from (d.name || ' ' || COALESCE(txt, ''))))
      WHERE id = d.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE "Drawing" SET "searchText" = lower(d.name) WHERE id = d.id;
    END;
  END LOOP;
END $$;
