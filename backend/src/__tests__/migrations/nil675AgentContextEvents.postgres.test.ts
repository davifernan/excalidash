import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { appendContextThreadEvent } from "../../agent/contextThread";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260829143000_add_agent_context_events";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-675 postgres migration: Agent Context event log", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-675 migration proof.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-675 postgres migration: Agent Context event log",
    () => {
      let client: Client | null = null;
      let clientWorkspace: string | null = null;
      let PostgresPrismaClient: any;

      beforeAll(async () => {
        const backendRoot = path.resolve(__dirname, "../../../");
        const workspaceRoot = path.join(backendRoot, ".prisma-test-clients");
        fs.mkdirSync(workspaceRoot, { recursive: true });
        clientWorkspace = fs.mkdtempSync(path.join(workspaceRoot, "nil675-postgres-"));
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
            path.join(backendRoot, "node_modules/prisma/build/index.js"),
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

      const migrated = async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil675_agent_context_events_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await client.query(
          `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
           VALUES ('u1','nil675@example.com','x','Owner','USER',now(),now())`,
        );
        await client.query(
          `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
           VALUES ('d1','Board','[]','{}','u1',now(),now())`,
        );
        await client.query(
          `INSERT INTO "AgentContext" (id,"drawingId","frameElementId","updatedAt")
           VALUES ('c1','d1','frame-1',now())`,
        );
        await applyPostgresMigration(client, TARGET);
        return client;
      };

      it("preserves Contexts, enforces sequence uniqueness and cascades events", async () => {
        const handle = await migrated();
        const existing = await handle.query(
          `SELECT id,"nextEventSequence" FROM "AgentContext" WHERE id='c1'`,
        );
        expect(existing.rows[0]).toEqual({ id: "c1", nextEventSequence: 0 });
        const insert = (id: string) =>
          handle.query(
            `INSERT INTO "AgentContextEvent"
             (id,"contextId",sequence,"actorKind","actorId","actorDisplayName","eventKind",payload)
             VALUES ($1,'c1',1,'agent','agent-1','Research','message','{"text":"A"}')`,
            [id],
          );
        await insert("e1");
        await expect(insert("e2")).rejects.toThrow(/duplicate key/i);
        await handle.query(`DELETE FROM "AgentContext" WHERE id='c1'`);
        expect((await handle.query(`SELECT id FROM "AgentContextEvent"`)).rows).toEqual([]);
      });

      it("runs the real append function concurrently across Postgres connections", async () => {
        const handle = await migrated();
        const databaseUrl = new URL(getPostgresTestUrl()!);
        databaseUrl.searchParams.set("schema", "nil675_agent_context_events_test");
        const prisma = new PostgresPrismaClient({
          datasources: { db: { url: databaseUrl.toString() } },
        });
        // With the production transaction, the first increment keeps the row
        // lock while this delay runs, so later writers cannot pass it. If the
        // transaction is removed, every increment commits before the delayed
        // read and concurrent callers observe the same counter value.
        prisma.$use(async (params: any, next: (params: any) => Promise<unknown>) => {
          if (params.model === "AgentContext" && params.action === "findUniqueOrThrow") {
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
          return next(params);
        });
        try {
          const events = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
              appendContextThreadEvent({
                prisma,
                drawingId: "d1",
                contextId: "c1",
                actor: { kind: "agent", id: `agent-${index}`, displayName: "Research" },
                kind: "message",
                payload: { text: `message-${index}` },
              }),
            ),
          );
          expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4, 5, 6,
          ]);
          expect(
            (
              await handle.query(`SELECT sequence FROM "AgentContextEvent" ORDER BY sequence ASC`)
            ).rows.map((row) => row.sequence),
          ).toEqual([1, 2, 3, 4, 5, 6]);
        } finally {
          await prisma.$disconnect();
        }
      }, 30_000);
    },
  );
}
