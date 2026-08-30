import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  confirmElementGuestProvenance,
  ElementGuestProvenanceConflictError,
  readElementGuestProvenance,
  recordSuccessfulElementMutation,
} from "../../agent/elementGuestProvenance";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260829173000_add_element_guest_provenance";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-695 postgres migration: element guest provenance", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is unset under CI=true.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-695 postgres migration: element guest provenance",
    () => {
      let client: Client | null = null;
      let clientWorkspace: string | null = null;
      let PostgresPrismaClient: any;

      beforeAll(async () => {
        const backendRoot = path.resolve(__dirname, "../../../");
        const workspaceRoot = path.join(backendRoot, ".prisma-test-clients");
        fs.mkdirSync(workspaceRoot, { recursive: true });
        clientWorkspace = fs.mkdtempSync(path.join(workspaceRoot, "nil695-postgres-"));
        const schemaPath = path.join(clientWorkspace, "schema.prisma");
        const clientOutput = path.join(clientWorkspace, "client");
        const sourceSchema = fs.readFileSync(
          path.join(backendRoot, "prisma/schema.prisma"),
          "utf8",
        );
        const postgresSchema = sourceSchema
          .replace(/(datasource\s+db\s*{[\s\S]*?provider\s*=\s*)"[^"]*"/, '$1"postgresql"')
          .replace(
            /(generator\s+client\s*{[\s\S]*?output\s*=\s*)"[^"]*"/,
            `$1${JSON.stringify(clientOutput)}`,
          );
        fs.writeFileSync(schemaPath, postgresSchema);
        execFileSync(
          process.execPath,
          [
            // Resolved, not `path.join(backendRoot, "node_modules/...")`: the
            // root Workspace hoists `prisma` to the repo root, not
            // `backend/node_modules` -- a resolved path survives the next
            // hoisting change, a hardcoded one does not (NIL-624).
            require.resolve("prisma/build/index.js"),
            "generate",
            "--schema",
            schemaPath,
          ],
          { cwd: backendRoot, stdio: "pipe" },
        );
        const generated = await import(pathToFileURL(path.join(clientOutput, "index.js")).href);
        PostgresPrismaClient = generated.PrismaClient ?? generated.default?.PrismaClient;
      }, 30_000);

      afterAll(() => {
        if (clientWorkspace) {
          const workspaceRoot = path.dirname(clientWorkspace);
          fs.rmSync(clientWorkspace, { recursive: true, force: true });
          try {
            fs.rmdirSync(workspaceRoot);
          } catch {
            // Another Postgres migration test may own a sibling workspace.
          }
        }
      });
      afterEach(async () => {
        await client?.end();
        client = null;
      });

      it("keeps legacy provenance absent and enforces drawing cascade", async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil695_element_guest_provenance_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await client.query(
          `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
           VALUES ('u1','nil695@example.com','x','Owner','USER',now(),now())`,
        );
        await client.query(
          `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
           VALUES ('d1','Board','[{"id":"legacy"}]','{}','u1',now(),now())`,
        );
        await applyPostgresMigration(client, TARGET);
        expect((await client.query(`SELECT * FROM "DrawingElementGuestProvenance"`)).rows).toEqual(
          [],
        );
        await client.query(
          `INSERT INTO "DrawingElementGuestProvenance"
           ("drawingId","elementId","everGuestTouched","updatedAt")
           VALUES ('d1','guest',true,now())`,
        );
        await client.query(`DELETE FROM "Drawing" WHERE id='d1'`);
        expect((await client.query(`SELECT * FROM "DrawingElementGuestProvenance"`)).rows).toEqual(
          [],
        );
      });

      it("runs the real revision guard when guest contact lands during confirmation", async () => {
        const handle = await (async () => {
          client = await createPostgresClient();
          await resetPostgresSchema(client, "nil695_element_guest_provenance_race_test");
          await applyPostgresMigrationsBefore(client, TARGET);
          await client.query(
            `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
             VALUES ('u1','nil695-race@example.com','x','Owner','USER',now(),now())`,
          );
          await client.query(
            `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
             VALUES ('d1','Board','[{"id":"note-1"}]','{}','u1',now(),now())`,
          );
          await applyPostgresMigration(client, TARGET);
          return client;
        })();
        const databaseUrl = new URL(getPostgresTestUrl()!);
        databaseUrl.searchParams.set("schema", "nil695_element_guest_provenance_race_test");
        const confirmationClient = new PostgresPrismaClient({
          datasources: { db: { url: databaseUrl.toString() } },
        });
        const guestClient = new PostgresPrismaClient({
          datasources: { db: { url: databaseUrl.toString() } },
        });
        try {
          await recordSuccessfulElementMutation({
            prisma: confirmationClient,
            drawingId: "d1",
            isGuest: true,
            changedElementIds: ["note-1"],
            createdElementIds: [],
          });
          let guestTouchInserted = false;
          const interleavedConfirmationClient = {
            drawingElementGuestProvenance: {
              findMany: (args: unknown) =>
                confirmationClient.drawingElementGuestProvenance.findMany(args),
            },
            $executeRaw: async (query: any) => {
              if (!guestTouchInserted) {
                guestTouchInserted = true;
                await recordSuccessfulElementMutation({
                  prisma: guestClient,
                  drawingId: "d1",
                  isGuest: true,
                  changedElementIds: ["note-1"],
                  createdElementIds: [],
                });
              }
              return confirmationClient.$executeRaw(query);
            },
          };

          await expect(
            confirmElementGuestProvenance(interleavedConfirmationClient, "d1", ["note-1"]),
          ).rejects.toBeInstanceOf(ElementGuestProvenanceConflictError);
          expect(await readElementGuestProvenance(confirmationClient, "d1", ["note-1"])).toEqual([
            { elementId: "note-1", status: "guest-touched" },
          ]);
          expect(
            (
              await handle.query(
                `SELECT "everGuestTouched", revision FROM "DrawingElementGuestProvenance" WHERE "drawingId"='d1' AND "elementId"='note-1'`,
              )
            ).rows[0],
          ).toEqual({ everGuestTouched: true, revision: 2 });
        } finally {
          await Promise.all([confirmationClient.$disconnect(), guestClient.$disconnect()]);
        }
      }, 30_000);
    },
  );
}
