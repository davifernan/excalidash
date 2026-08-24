import { describe, expect, it } from "vitest";
import { MAX_OPS_PER_BATCH, opSchema, opsBatchSchema } from "./opSchemas";

describe("opSchemas", () => {
  it("accepts a well-formed create op with arbitrary passthrough fields", () => {
    const result = opSchema.safeParse({
      op: "create",
      element: { type: "rectangle", x: 1, y: 2, strokeColor: "#000", customWidgetPayload: { foo: "bar" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a create op that supplies a server-assigned field", () => {
    for (const field of ["id", "version", "versionNonce", "updated", "isDeleted"]) {
      const result = opSchema.safeParse({
        op: "create",
        element: { type: "rectangle", x: 1, y: 2, [field]: "client-supplied" },
      });
      expect(result.success, `field "${field}" should be rejected`).toBe(false);
    }
  });

  it("rejects an update patch that supplies a server-assigned field", () => {
    for (const field of ["id", "version", "versionNonce", "updated", "isDeleted"]) {
      const result = opSchema.safeParse({
        op: "update",
        id: "el-1",
        patch: { x: 1, [field]: "client-supplied" },
      });
      expect(result.success, `field "${field}" should be rejected`).toBe(false);
    }
  });

  it("rejects an update patch that tries to change type", () => {
    const result = opSchema.safeParse({ op: "update", id: "el-1", patch: { type: "ellipse" } });
    expect(result.success).toBe(false);
  });

  it("rejects a create with non-finite geometry", () => {
    for (const bad of [Infinity, NaN, -Infinity]) {
      const result = opSchema.safeParse({ op: "create", element: { type: "rectangle", x: bad, y: 0 } });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an unknown op discriminator", () => {
    const result = opSchema.safeParse({ op: "replace-everything", id: "el-1" });
    expect(result.success).toBe(false);
  });

  it("accepts a delete op", () => {
    expect(opSchema.safeParse({ op: "delete", id: "el-1" }).success).toBe(true);
  });

  it("caps a batch at MAX_OPS_PER_BATCH operations", () => {
    const atLimit = {
      version: 1,
      ops: Array.from({ length: MAX_OPS_PER_BATCH }, (_, i) => ({
        op: "create" as const,
        element: { type: "rectangle", x: i, y: 0 },
      })),
    };
    expect(opsBatchSchema.safeParse(atLimit).success).toBe(true);

    const overLimit = {
      version: 1,
      ops: [...atLimit.ops, { op: "create" as const, element: { type: "rectangle", x: 0, y: 0 } }],
    };
    expect(opsBatchSchema.safeParse(overLimit).success).toBe(false);
  });

  it("rejects an empty ops array", () => {
    expect(opsBatchSchema.safeParse({ version: 1, ops: [] }).success).toBe(false);
  });

  it("requires a non-negative integer version", () => {
    expect(opsBatchSchema.safeParse({ version: -1, ops: [{ op: "delete", id: "x" }] }).success).toBe(
      false,
    );
    expect(opsBatchSchema.safeParse({ version: 1.5, ops: [{ op: "delete", id: "x" }] }).success).toBe(
      false,
    );
  });
});
