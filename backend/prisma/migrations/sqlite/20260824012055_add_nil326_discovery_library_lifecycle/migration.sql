-- CreateTable
CREATE TABLE "LibraryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "excalidrawItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'personal',
    "ownerUserId" TEXT NOT NULL,
    "excalidrawData" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LibraryItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- DataMigration: one-time move of every existing per-account `Library` blob
-- (`items` is a JSON array of Excalidraw's own native library-item shape)
-- into one `LibraryItem` row per item, owned by the same account and
-- defaulted to "personal" visibility -- nothing is force-shared to the team
-- by this migration (NIL-364's own acceptance line: an item stays exactly
-- as visible after the migration as it was before it).
--
-- Guarded three ways so a bad historical row degrades to "skipped", not to
-- a failed migration that blocks every self-hosted install's upgrade:
--   - `json_valid(lib.items)` -- a corrupt blob is skipped, not fatal.
--   - the `EXISTS` User check -- a `Library` row for an already-deleted
--     account (offboarding pre-NIL-364 only detached the exact `user_<id>`
--     row, so a row for a *since*-deleted account cannot exist today, but a
--     future backport or a hand-edited dev database could still have one)
--     is skipped rather than violating the new foreign key.
--   - `INSERT OR IGNORE` -- a duplicate `(ownerUserId, excalidrawItemId)`
--     pair (should not occur; Excalidraw already keeps ids unique within one
--     account's own library) is skipped rather than aborting the migration.
-- A missing `name` on an item (native Excalidraw library items do not
-- always carry one) falls back to "Imported item" -- visible and editable
-- from the Team Library UI afterward, never blank.
INSERT OR IGNORE INTO "LibraryItem"
  ("id", "excalidrawItemId", "name", "category", "visibility", "ownerUserId", "excalidrawData", "createdAt", "updatedAt")
SELECT
  'mig-' || lower(hex(randomblob(16))),
  COALESCE(json_extract(item.value, '$.id'), 'mig-item-' || lower(hex(randomblob(8)))),
  COALESCE(json_extract(item.value, '$.name'), 'Imported item'),
  NULL,
  'personal',
  substr(lib.id, 6),
  item.value,
  lib."createdAt",
  lib."updatedAt"
FROM "Library" AS lib, json_each(lib.items) AS item
WHERE json_valid(lib.items)
  AND lib.id LIKE 'user\_%' ESCAPE '\'
  AND EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = substr(lib.id, 6));

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Library";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Drawing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "elements" TEXT NOT NULL,
    "appState" TEXT NOT NULL,
    "files" TEXT NOT NULL DEFAULT '{}',
    "preview" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "nameRevision" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "collectionId" TEXT,
    "archivedAt" DATETIME,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Drawing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Drawing_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Drawing_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Drawing" ("appState", "collectionId", "createdAt", "createdByUserId", "elements", "files", "id", "name", "nameRevision", "preview", "updatedAt", "userId", "version") SELECT "appState", "collectionId", "createdAt", "createdByUserId", "elements", "files", "id", "name", "nameRevision", "preview", "updatedAt", "userId", "version" FROM "Drawing";
DROP TABLE "Drawing";
ALTER TABLE "new_Drawing" RENAME TO "Drawing";
CREATE INDEX "Drawing_userId_updatedAt_idx" ON "Drawing"("userId", "updatedAt");
CREATE INDEX "Drawing_userId_collectionId_updatedAt_idx" ON "Drawing"("userId", "collectionId", "updatedAt");
CREATE INDEX "Drawing_createdByUserId_idx" ON "Drawing"("createdByUserId");
CREATE INDEX "Drawing_archivedAt_idx" ON "Drawing"("archivedAt");
CREATE TABLE "new_LinkPreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cacheKey" TEXT NOT NULL,
    "requestedUrl" TEXT NOT NULL,
    "resolvedUrl" TEXT,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "title" TEXT,
    "description" TEXT,
    "imageBlobId" TEXT,
    "faviconBlobId" TEXT,
    "ownerUserId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LinkPreview_imageBlobId_fkey" FOREIGN KEY ("imageBlobId") REFERENCES "StoredBlob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LinkPreview_faviconBlobId_fkey" FOREIGN KEY ("faviconBlobId") REFERENCES "StoredBlob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LinkPreview" ("cacheKey", "createdAt", "description", "expiresAt", "failureCode", "faviconBlobId", "id", "imageBlobId", "lastAccessedAt", "ownerUserId", "requestedUrl", "resolvedUrl", "status", "title", "updatedAt") SELECT "cacheKey", "createdAt", "description", "expiresAt", "failureCode", "faviconBlobId", "id", "imageBlobId", "lastAccessedAt", "ownerUserId", "requestedUrl", "resolvedUrl", "status", "title", "updatedAt" FROM "LinkPreview";
DROP TABLE "LinkPreview";
ALTER TABLE "new_LinkPreview" RENAME TO "LinkPreview";
CREATE UNIQUE INDEX "LinkPreview_cacheKey_key" ON "LinkPreview"("cacheKey");
CREATE INDEX "LinkPreview_expiresAt_idx" ON "LinkPreview"("expiresAt");
CREATE INDEX "LinkPreview_ownerUserId_lastAccessedAt_idx" ON "LinkPreview"("ownerUserId", "lastAccessedAt");
CREATE INDEX "LinkPreview_lastAccessedAt_idx" ON "LinkPreview"("lastAccessedAt");
CREATE INDEX "LinkPreview_imageBlobId_idx" ON "LinkPreview"("imageBlobId");
CREATE INDEX "LinkPreview_faviconBlobId_idx" ON "LinkPreview"("faviconBlobId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DataMigration: backfill NIL-363's search text for every board that
-- existed before this column did. A board with a corrupt `elements` string
-- (should not exist; every writer goes through `JSON.stringify`) does not
-- fail the whole migration -- but it must still end up name-only
-- searchable, not silently invisible to search entirely. The two UPDATEs
-- below are that split: `json_valid("elements")` computes name + content
-- exactly as before; its complement (Hans-Friedrich, PR #66) is the
-- fallback that the postgresql migration's per-row EXCEPTION handler
-- already provided and this one did not -- a row skipped by the first
-- UPDATE stayed at the column default `''`, invisible even by its own
-- name, not merely missing its content match.
UPDATE "Drawing"
SET "searchText" = lower(trim(
  "name" || ' ' || COALESCE((
    SELECT group_concat(json_extract(el.value, '$.text'), ' ')
    FROM json_each("Drawing"."elements") AS el
    WHERE json_extract(el.value, '$.type') = 'text'
      AND (json_extract(el.value, '$.isDeleted') IS NULL OR json_extract(el.value, '$.isDeleted') = 0)
      AND json_extract(el.value, '$.text') IS NOT NULL
  ), '')
))
WHERE json_valid("elements");

UPDATE "Drawing"
SET "searchText" = lower(trim("name"))
WHERE NOT json_valid("elements");

-- CreateIndex
CREATE INDEX "LibraryItem_visibility_category_idx" ON "LibraryItem"("visibility", "category");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryItem_ownerUserId_excalidrawItemId_key" ON "LibraryItem"("ownerUserId", "excalidrawItemId");
