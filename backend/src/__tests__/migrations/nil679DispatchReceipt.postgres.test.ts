import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  applyPostgresMigration,
  applyPostgresMigrationsBefore,
  createPostgresClient,
  getPostgresTestUrl,
  resetPostgresSchema,
} from "./runPostgresMigration";

const TARGET = "20260830033000_add_dispatch_receipts";

if (process.env.CI === "true" && !getPostgresTestUrl()) {
  describe("NIL-679 postgres migration: public DispatchReceipt", () => {
    it("requires the real Postgres service in CI", () => {
      throw new Error("POSTGRES_TEST_URL is required for the NIL-679 migration proof.");
    });
  });
} else {
  describe.skipIf(!getPostgresTestUrl())(
    "NIL-679 postgres migration: public DispatchReceipt",
    () => {
      let client: Client | null = null;
      afterEach(async () => {
        await client?.end();
        client = null;
      });

      it("installs the receipt, lease binding, event and one-shot outbox tables", async () => {
        client = await createPostgresClient();
        await resetPostgresSchema(client, "nil679_dispatch_receipt_test");
        await applyPostgresMigrationsBefore(client, TARGET);
        await applyPostgresMigration(client, TARGET);
        const result = await client.query(
          `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('AgentDispatchReceipt','AgentDispatchLease','AgentDispatchReceiptEvent','AgentDispatchOutbox')
         ORDER BY table_name`,
        );
        expect(result.rows.map((row) => row.table_name)).toEqual([
          "AgentDispatchLease",
          "AgentDispatchOutbox",
          "AgentDispatchReceipt",
          "AgentDispatchReceiptEvent",
        ]);
        await expect(
          client.query(
            `INSERT INTO "AgentDispatchOutbox" ("dispatchId",state,"updatedAt")
           VALUES ('missing','invented',now())`,
          ),
        ).rejects.toThrow(/check constraint/i);
      });
    },
  );
}
