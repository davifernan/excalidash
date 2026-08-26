import { describe, expect, it } from "vitest";
import { requestIdOf, requestIdOrUnknown } from "./requestId";

const request = (value: unknown) => ({ headers: { "x-request-id": value } }) as never;

describe("request ID extraction", () => {
  it("keeps a single request ID and rejects empty or multi-value headers", () => {
    expect(requestIdOf(request("request-622"))).toBe("request-622");
    expect(requestIdOf(request(""))).toBeUndefined();
    expect(requestIdOf(request(["first", "second"]))).toBeUndefined();
  });

  it("uses unknown only for logs and error responses that require a string", () => {
    expect(requestIdOrUnknown(request(undefined))).toBe("unknown");
  });
});
