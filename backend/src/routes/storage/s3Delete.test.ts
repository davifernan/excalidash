import { describe, expect, it, vi } from "vitest";
import { deleteS3KeysInBatches } from "./s3Delete";

const logged = (spy: ReturnType<typeof vi.spyOn>) =>
  (spy.mock.calls as unknown as [string][]).map((call) => JSON.parse(call[0]));

describe("deleteS3KeysInBatches", () => {
  it("reports successful and failed S3 object deletes", async () => {
    const deleteObject = vi.fn(async (key: string) => {
      if (key === "bad-key") throw new Error("delete failed");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await deleteS3KeysInBatches({
      keys: ["good-key", "bad-key", "another-good-key"],
      logPrefix: "[test]",
      deleteObject,
    });

    expect(result).toEqual({ deleted: 2, errors: 1 });
    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(logged(stderrSpy)).toHaveLength(1);
    expect(logged(stderrSpy)[0]).toMatchObject({
      level: "error",
      message: "failed to delete S3 object",
      logPrefix: "[test]",
      key: "bad-key",
    });
    stderrSpy.mockRestore();
  });
});
