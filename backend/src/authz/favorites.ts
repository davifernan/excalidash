import type { PrismaClient } from "../generated/client";

/**
 * Whether this account has starred a board (NIL-292). Per-viewer, same shape
 * as `DrawingVisit` in `comments/activityFeed.ts` -- a board has no single
 * "is it a favorite" answer, only "is it a favorite of the person asking".
 */
export const setDrawingFavorite = (params: {
  prisma: PrismaClient;
  userId: string;
  drawingId: string;
  favorite: boolean;
}) =>
  params.favorite
    ? params.prisma.drawingFavorite.upsert({
        where: { userId_drawingId: { userId: params.userId, drawingId: params.drawingId } },
        create: { userId: params.userId, drawingId: params.drawingId },
        update: {},
      })
    : params.prisma.drawingFavorite.deleteMany({
        where: { userId: params.userId, drawingId: params.drawingId },
      });

/**
 * Which of these boards this account has starred, batched -- one query for a
 * whole list, not one per card (same reasoning as `authz/roster.ts`'s
 * `getDrawingRosters`).
 */
export const getFavoriteDrawingIds = async (params: {
  prisma: PrismaClient;
  userId: string;
  drawingIds: readonly string[];
}): Promise<Set<string>> => {
  if (params.drawingIds.length === 0) return new Set();
  const rows = await params.prisma.drawingFavorite.findMany({
    where: { userId: params.userId, drawingId: { in: [...params.drawingIds] } },
    select: { drawingId: true },
  });
  return new Set(rows.map((row) => row.drawingId));
};
