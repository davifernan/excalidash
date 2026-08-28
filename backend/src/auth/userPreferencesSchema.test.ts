import { describe, expect, it } from "vitest";
import { userPreferencesSchema } from "./schemas";

describe("userPreferencesSchema", () => {
  it("accepts a toolbar feature id list (NIL-655)", () => {
    const result = userPreferencesSchema.safeParse({
      toolbarFeatureIds: ["workshop-timer", "comments"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty list -- a viewer who deliberately turned everything off", () => {
    const result = userPreferencesSchema.safeParse({ toolbarFeatureIds: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a non-string entry", () => {
    const result = userPreferencesSchema.safeParse({ toolbarFeatureIds: [42] });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded list", () => {
    const result = userPreferencesSchema.safeParse({
      toolbarFeatureIds: Array.from({ length: 33 }, (_, i) => `feature-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("still rejects an unknown top-level key", () => {
    const result = userPreferencesSchema.safeParse({ somethingElse: true });
    expect(result.success).toBe(false);
  });
});
