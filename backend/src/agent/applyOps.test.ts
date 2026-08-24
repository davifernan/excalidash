import { describe, expect, it } from "vitest";
import { applyOperations } from "./applyOps";
import { opSchema } from "./opSchemas";

const op = (raw: unknown) => opSchema.parse(raw);

describe("applyOperations", () => {
  it("creates an element with a server-assigned id, version 1, and isDeleted false", () => {
    const result = applyOperations([], [op({ op: "create", element: { type: "rectangle", x: 1, y: 2 } })]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elements) return;
    expect(result.elements).toHaveLength(1);
    const el = result.elements[0];
    expect(typeof el.id).toBe("string");
    expect(el.id).not.toBe("");
    expect(el.version).toBe(1);
    expect(el.isDeleted).toBe(false);
    expect(el.type).toBe("rectangle");
  });

  it("updates an existing element, incrementing its version and bumping updated/versionNonce", () => {
    const existing = { id: "el-1", type: "rectangle", x: 0, y: 0, version: 3, versionNonce: 111, updated: 100 };
    const result = applyOperations([existing], [op({ op: "update", id: "el-1", patch: { x: 50 } })]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elements) return;
    const el = result.elements[0];
    expect(el.x).toBe(50);
    expect(el.y).toBe(0); // untouched fields survive
    expect(el.version).toBe(4);
    expect(el.versionNonce).not.toBe(111);
    expect(el.updated).not.toBe(100);
    expect(el.id).toBe("el-1"); // patch cannot smuggle a different id even if the schema allowed it
  });

  it("soft-deletes: marks isDeleted true and keeps the element in the array", () => {
    const existing = { id: "el-1", type: "rectangle", x: 0, y: 0, version: 1 };
    const result = applyOperations([existing], [op({ op: "delete", id: "el-1" })]);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elements) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].isDeleted).toBe(true);
    expect(result.elements[0].version).toBe(2);
  });

  it("rejects the whole batch when an op references an unknown id, applying nothing", () => {
    const existing = { id: "el-1", type: "rectangle", x: 0, y: 0, version: 1 };
    const result = applyOperations(
      [existing],
      [
        op({ op: "update", id: "el-1", patch: { x: 99 } }),
        op({ op: "update", id: "does-not-exist", patch: { x: 1 } }),
      ],
    );
    expect(result).toEqual({
      ok: false,
      error: 'Operation "update" references unknown element id "does-not-exist"',
    });
  });

  it("rejects an op that targets an already-deleted element -- a delete is not a valid update/delete target", () => {
    const existing = { id: "el-1", type: "rectangle", x: 0, y: 0, version: 1, isDeleted: true };
    const result = applyOperations([existing], [op({ op: "update", id: "el-1", patch: { x: 1 } })]);
    expect(result.ok).toBe(false);
  });

  it("preserves original element order and appends created elements at the end", () => {
    const a = { id: "a", type: "rectangle", x: 0, y: 0 };
    const b = { id: "b", type: "rectangle", x: 0, y: 0 };
    const result = applyOperations(
      [a, b],
      [
        op({ op: "update", id: "b", patch: { x: 5 } }),
        op({ op: "create", element: { type: "ellipse", x: 9, y: 9 } }),
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elements) return;
    expect(result.elements.map((el) => el.id)[0]).toBe("a");
    expect(result.elements.map((el) => el.id)[1]).toBe("b");
    expect(result.elements[2].type).toBe("ellipse");
  });

  it("does not mutate the input array or its elements", () => {
    const existing = { id: "el-1", type: "rectangle", x: 0, y: 0, version: 1 };
    const input = [existing];
    applyOperations(input, [op({ op: "update", id: "el-1", patch: { x: 99 } })]);
    expect(input[0]).toBe(existing);
    expect(existing.x).toBe(0);
  });

  it("applies multiple ops in order within one batch", () => {
    const a = { id: "a", type: "rectangle", x: 0, y: 0, version: 1 };
    const b = { id: "b", type: "rectangle", x: 0, y: 0, version: 1 };
    const result = applyOperations(
      [a, b],
      [op({ op: "update", id: "a", patch: { x: 1 } }), op({ op: "delete", id: "b" })],
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.elements) return;
    expect(result.elements[0].x).toBe(1);
    expect(result.elements[1].isDeleted).toBe(true);
  });
});
