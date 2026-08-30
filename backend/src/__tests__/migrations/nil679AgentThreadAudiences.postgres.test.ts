import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { appendAgentThreadEvent } from "../../agent/contextThread";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260830024500_add_agent_thread_audiences";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-679 postgres migration: Agent thread audiences", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-679 migration proof.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-679 postgres migration: Agent thread audiences",
    () => {
      let client: Client | null = null;
      let clientWorkspace: string | null = null;
      let PostgresPrismaClient: any;

      beforeAll(async () => {
        const backendRoot = path.resolve(__dirname, "../../../");
        const workspaceRoot = path.join(backendRoot, ".prisma-test-clients");
        fs.mkdirSync(workspaceRoot, { recursive: true });
        clientWorkspace = fs.mkdtempSync(path.join(workspaceRoot, "nil679-postgres-"));
        const schemaPath = path.join(clientWorkspace, "schema.prisma");
        const clientOutput = path.join(clientWorkspace, "client");
        const sourceSchema = fs.readFileSync(
          path.join(backendRoot, "prisma/schema.prisma"),
          "utf8",
        );
        fs.writeFileSync(
          schemaPath,
          sourceSchema
            .replace(/(datasource\s+db\s*{[\s\S]*?provider\s*=\s*)"[^"]*"/, '$1"postgresql"')
            .replace(
              /(generator\s+client\s*{[\s\S]*?output\s*=\s*)"[^"]*"/,
              `$1${JSON.stringify(clientOutput)}`,
            ),
        );
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
        if (clientWorkspace) fs.rmSync(clientWorkspace, { recursive: true, force: true });
      });
      afterEach(async () => {
        await client?.end();
        client = null;
      });

      const migrated = async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil679_agent_thread_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await client.query(
          `INSERT INTO "User" (id,email,"passwordHash",name,role,"createdAt","updatedAt")
         VALUES ('u1','nil679@example.com','x','Owner','USER',now(),now())`,
        );
        await client.query(
          `INSERT INTO "Drawing" (id,name,elements,"appState","userId","createdAt","updatedAt")
         VALUES ('d1','Board','[]','{}','u1',now(),now())`,
        );
        await client.query(
          `INSERT INTO "AgentContext" (id,"drawingId","frameElementId","nextEventSequence","createdAt","updatedAt")
         VALUES ('c1','d1','frame-1',1,now(),now())`,
        );
        await client.query(
          `INSERT INTO "AgentContextEvent"
         (id,"contextId",sequence,"actorKind","actorId","actorDisplayName","eventKind",payload)
         VALUES ('e1','c1',1,'agent','a1','Research','message','{"text":"preserved"}')`,
        );
        await applyPostgresMigration(client, TARGET);
        return client;
      };

      it("preserves old events and serializes the real append function across connections", async () => {
        const handle = await migrated();
        expect(
          (
            await handle.query(
              `SELECT "threadId",sequence,payload FROM "AgentThreadEvent" ORDER BY sequence`,
            )
          ).rows,
        ).toEqual([{ threadId: "c1", sequence: 1, payload: '{"text":"preserved"}' }]);

        const databaseUrl = new URL(getPostgresTestUrl()!);
        databaseUrl.searchParams.set("schema", "nil679_agent_thread_test");
        const prisma = new PostgresPrismaClient({
          datasources: { db: { url: databaseUrl.toString() } },
        });
        prisma.$use(async (params: any, next: (params: any) => Promise<unknown>) => {
          if (params.model === "AgentThread" && params.action === "findUniqueOrThrow") {
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
          return next(params);
        });
        try {
          const events = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
              appendAgentThreadEvent({
                prisma,
                drawingId: "d1",
                threadId: "c1",
                actor: { kind: "agent", id: `a${index}`, displayName: "Research" },
                kind: "message",
                payload: { text: `message-${index}` },
              }),
            ),
          );
          expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([
            2, 3, 4, 5, 6, 7,
          ]);
        } finally {
          await prisma.$disconnect();
        }
      }, 30_000);
    },
  );
}
