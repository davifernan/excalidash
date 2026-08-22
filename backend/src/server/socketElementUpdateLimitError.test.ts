import { describe, expect, it } from "vitest";
import { elementUpdateLimitError, SOCKET_LIMITS } from "./socketProtocol";

const drawingId = "drawing-1";

describe("element-update limit reasons", () => {
  it.each([
    {
      name: "element count",
      payload: {
        drawingId,
        elements: Array.from({ length: SOCKET_LIMITS.elementsPerUpdate + 1 }, (_, index) => ({
          id: `element-${index}`,
        })),
      },
      code: "too-many-elements",
    },
    {
      name: "individual element bytes",
      payload: {
        drawingId,
        elements: [{ id: "large", padding: "x".repeat(SOCKET_LIMITS.elementBytes) }],
      },
      code: "element-too-large",
    },
    {
      name: "file count",
      payload: {
        drawingId,
        elements: [],
        files: Object.fromEntries(
          Array.from({ length: SOCKET_LIMITS.filesPerUpdate + 1 }, (_, index) => [
            `file-${index}`,
            {},
          ]),
        ),
      },
      code: "too-many-files",
    },
    {
      name: "individual file bytes",
      payload: {
        drawingId,
        elements: [],
        files: {
          image: { dataURL: "x".repeat(SOCKET_LIMITS.fileDataUrlLength + 1) },
        },
      },
      code: "file-too-large",
    },
  ])("classifies the $name ceiling without echoing payload data", ({ payload, code }) => {
    const error = elementUpdateLimitError(payload);
    expect(error?.code).toBe(code);
    expect(error?.message).not.toContain("xxxx");
  });

  it("leaves malformed non-limit payloads classified as invalid requests", () => {
    expect(elementUpdateLimitError({ drawingId, elements: "not-an-array" })).toBeNull();
  });

  it.each([
    {
      name: "element fields",
      payload: {
        drawingId,
        elements: [
          {
            id: "element-1",
            type: "x".repeat(65),
            padding: "y".repeat(SOCKET_LIMITS.elementBytes),
          },
        ],
      },
    },
    {
      name: "file ids",
      payload: {
        drawingId,
        elements: [],
        files: {
          "not/a/file/id": { dataURL: "x".repeat(SOCKET_LIMITS.fileDataUrlLength + 1) },
        },
      },
    },
  ])("does not disguise malformed $name as limit refusals", ({ payload }) => {
    expect(elementUpdateLimitError(payload)).toBeNull();
  });
});
