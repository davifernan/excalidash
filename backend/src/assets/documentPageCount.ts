import { readStoredBytes } from "./assetStorage";
import { paginateDocumentSource } from "./documentPagination";

/**
 * Backfill deterministic page counts for text assets created before the count
 * became part of the server contract. The conditional update makes concurrent
 * first requests converge without a read-modify-write race.
 */
export async function deriveAssetPageCount(
  prisma: any,
  storageDir: string,
  assetId: string,
): Promise<number | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      kind: true,
      pageCount: true,
      status: true,
      blob: { select: { storageKey: true, contentEncoding: true } },
    },
  });
  if (!asset || asset.status !== "READY") return null;
  if (typeof asset.pageCount === "number") return asset.pageCount;
  if (!asset.blob || !["MARKDOWN", "TEXT"].includes(asset.kind)) return null;

  const source = (await readStoredBytes(storageDir, asset.blob)).toString("utf8");
  const pageCount = paginateDocumentSource(source, asset.kind).length;
  await prisma.asset.updateMany({
    where: { id: assetId, pageCount: null },
    data: { pageCount },
  });
  return pageCount;
}
