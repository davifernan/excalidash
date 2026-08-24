/**
 * The postgres counterpart to nil381DrawingFiles.test.ts (NIL-381/NIL-503):
 * runs the real postgresql migration.sql from
 * `prisma/migrations/postgresql/20260824130800_add_nil381_drawing_files/`
 * against a real Postgres connection.
 *
 * Skips (does not silently pass) when POSTGRES_TEST_URL is unset, EXCEPT
 * under CI, where it fails loudly instead -- same guard as the other
 * postgres migration tests in this directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET_MIGRATION = "20260824130800_add_nil381_drawing_files";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-381 postgres migration: DrawingFile", () => {
    it("POSTGRES_TEST_URL must be set in CI -- the postgres service container is not wired up", () => {
      throw new Error(
        "POSTGRES_TEST_URL is unset under CI=true. This test exists to run against a real " +
          "postgres:16-alpine service container (NIL-496), not to skip.",
      );
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())("NIL-381 postgres migration: DrawingFile", () => {
    let client: Client | null = null;

    afterEach(async () => {
      await client?.end();
      client = null;
    });

    const seedPreMigrationDb = async (): Promise<Client> => {
      const handle = await createPostgresClient();
      await resetPostgresSchema(handle, "nil381_drawing_files_test");
      await applyPostgresMigrationsBefore(handle, TARGET_MIGRATION);

      await handle.query(
        `INSERT INTO "User" (id, email, "passwordHash", name, role, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        ["u1", "a@example.com", "x", "Alice", "USER"],
      );

      await handle.query(
        `INSERT INTO "Drawing" (id, name, elements, "appState", "userId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        ["d1", "Board One", "[]", "{}", "u1"],
      );

      await handle.query(
        `INSERT INTO "StoredBlob" (id, sha256, "sizeBytes", "storedBytes", "storageKey", purpose, state, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
        ["blob1", "a".repeat(64), 1024, 1024, "originals/aa/bb/blob1", "IMAGE", "READY"],
      );

      return handle;
    };

    it("accepts a DrawingFile row referencing an existing drawing and blob", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await client.query(
        `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        ["d1", "file1", "blob1", "u1", "image/png"],
      );

      const { rows } = await client.query(
        `SELECT "blobId", "ownerUserId", "mimeType" FROM "DrawingFile" WHERE "drawingId" = $1 AND "fileId" = $2`,
        ["d1", "file1"],
      );
      expect(rows[0].blobId).toBe("blob1");
      expect(rows[0].ownerUserId).toBe("u1");
      expect(rows[0].mimeType).toBe("image/png");
    });

    it("enforces the drawingId foreign key", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await expect(
        client.query(
          `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
           VALUES ($1, $2, $3, $4, $5, now())`,
          ["does-not-exist", "file1", "blob1", "u1", "image/png"],
        ),
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it("enforces the blobId foreign key", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await expect(
        client.query(
          `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
           VALUES ($1, $2, $3, $4, $5, now())`,
          ["d1", "file1", "does-not-exist", "u1", "image/png"],
        ),
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it("rejects a duplicate (drawingId, fileId) binding", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await client.query(
        `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        ["d1", "file1", "blob1", "u1", "image/png"],
      );

      await expect(
        client.query(
          `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
           VALUES ($1, $2, $3, $4, $5, now())`,
          ["d1", "file1", "blob1", "u1", "image/png"],
        ),
      ).rejects.toThrow(/duplicate key/i);
    });

    it("cascades: deleting the drawing deletes its file references", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await client.query(
        `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        ["d1", "file1", "blob1", "u1", "image/png"],
      );

      await client.query(`DELETE FROM "Drawing" WHERE id = $1`, ["d1"]);

      const { rows } = await client.query(`SELECT "drawingId" FROM "DrawingFile" WHERE "drawingId" = $1`, [
        "d1",
      ]);
      expect(rows.length).toBe(0);
    });

    it("restricts: deleting a blob still referenced by a DrawingFile row is blocked", async () => {
      client = await seedPreMigrationDb();
      await applyPostgresMigration(client, TARGET_MIGRATION);

      await client.query(
        `INSERT INTO "DrawingFile" ("drawingId", "fileId", "blobId", "ownerUserId", "mimeType", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        ["d1", "file1", "blob1", "u1", "image/png"],
      );

      await expect(client.query(`DELETE FROM "StoredBlob" WHERE id = $1`, ["blob1"])).rejects.toThrow(
        /foreign key constraint/i,
      );
    });
  });
}
