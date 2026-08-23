import type { Prisma, PrismaClient } from "../generated/client";
import { getDrawingMemberships } from "../authz/membership";

export type ActivityEventDTO = {
  id: string;
  drawingId: string;
  drawingName: string;
  actorUserId: string;
  actorName: string;
  verb: string;
  commentId: string | null;
  elementId: string | null;
  anchorX: number | null;
  anchorY: number | null;
  summary: string;
  createdAt: string;
};

const EVENT_SELECT = {
  id: true,
  drawingId: true,
  drawing: { select: { name: true } },
  actorUserId: true,
  actor: { select: { name: true } },
  verb: true,
  commentId: true,
  elementId: true,
  anchorX: true,
  anchorY: true,
  summary: true,
  createdAt: true,
} satisfies Prisma.ActivityEventSelect;

type RawEvent = Prisma.ActivityEventGetPayload<{ select: typeof EVENT_SELECT }>;

const toEventDTO = (row: RawEvent): ActivityEventDTO => ({
  id: row.id,
  drawingId: row.drawingId,
  drawingName: row.drawing.name,
  actorUserId: row.actorUserId,
  actorName: row.actor.name,
  verb: row.verb,
  commentId: row.commentId,
  elementId: row.elementId,
  anchorX: row.anchorX,
  anchorY: row.anchorY,
  summary: row.summary,
  createdAt: row.createdAt.toISOString(),
});

const parseCursor = (before?: string | null): Date | undefined => {
  if (!before) return undefined;
  const date = new Date(before);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

export const listDrawingActivity = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  limit: number;
  before?: string | null;
}): Promise<ActivityEventDTO[]> => {
  const cursor = parseCursor(params.before);
  const rows = await params.prisma.activityEvent.findMany({
    where: { drawingId: params.drawingId, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
    select: EVENT_SELECT,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.limit, 1), 100),
  });
  return rows.map(toEventDTO);
};

/**
 * The team-wide feed: newest first, filtered to boards the viewer actually
 * has a standing claim on.
 *
 * There is no single WHERE clause for "every event on every board I can
 * see" that would not become a second, drifting copy of ownership logic
 * (see boards.ts). Instead this fetches recent events, asks the one
 * membership contract which of their boards the viewer belongs to, and
 * drops the rest -- batched per page rather than per row, and topped up a
 * bounded number of times if a page happens to be mostly boards the viewer
 * cannot see.
 */
export const listTeamActivity = async (params: {
  prisma: PrismaClient;
  viewerUserId: string;
  limit: number;
  before?: string | null;
}): Promise<ActivityEventDTO[]> => {
  const limit = Math.min(Math.max(params.limit, 1), 100);
  const results: ActivityEventDTO[] = [];
  let cursor = parseCursor(params.before);
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS && results.length < limit; round += 1) {
    const batch = await params.prisma.activityEvent.findMany({
      where: cursor ? { createdAt: { lt: cursor } } : {},
      select: EVENT_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit * 2,
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].createdAt;

    const drawingIds = Array.from(new Set(batch.map((row) => row.drawingId)));
    const memberships = await getDrawingMemberships({
      prisma: params.prisma,
      userId: params.viewerUserId,
      drawingIds,
    });
    for (const row of batch) {
      if (!memberships.has(row.drawingId)) continue;
      results.push(toEventDTO(row));
      if (results.length >= limit) break;
    }
  }
  return results;
};

export type NotificationDTO = {
  id: string;
  kind: string;
  readAt: string | null;
  createdAt: string;
  event: ActivityEventDTO;
};

export const listInbox = async (params: {
  prisma: PrismaClient;
  userId: string;
  unreadOnly: boolean;
  limit: number;
  before?: string | null;
}): Promise<NotificationDTO[]> => {
  const cursor = parseCursor(params.before);
  const rows = await params.prisma.notification.findMany({
    where: {
      recipientUserId: params.userId,
      ...(params.unreadOnly ? { readAt: null } : {}),
      ...(cursor ? { createdAt: { lt: cursor } } : {}),
    },
    select: {
      id: true,
      kind: true,
      readAt: true,
      createdAt: true,
      activityEvent: { select: EVENT_SELECT },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.limit, 1), 100),
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    event: toEventDTO(row.activityEvent),
  }));
};

export const unreadNotificationCount = (params: { prisma: PrismaClient; userId: string }) =>
  params.prisma.notification.count({
    where: { recipientUserId: params.userId, readAt: null },
  });

/** Only the recipient's own row; a notification id from someone else's inbox is a 404, not a 403. */
export const markNotificationRead = async (params: {
  prisma: PrismaClient;
  userId: string;
  notificationId: string;
}): Promise<boolean> => {
  const result = await params.prisma.notification.updateMany({
    where: { id: params.notificationId, recipientUserId: params.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count > 0;
};

export const markAllNotificationsRead = async (params: { prisma: PrismaClient; userId: string }) => {
  await params.prisma.notification.updateMany({
    where: { recipientUserId: params.userId, readAt: null },
    data: { readAt: new Date() },
  });
};

export const recordDrawingVisit = (params: { prisma: PrismaClient; userId: string; drawingId: string }) =>
  params.prisma.drawingVisit.upsert({
    where: { userId_drawingId: { userId: params.userId, drawingId: params.drawingId } },
    create: { userId: params.userId, drawingId: params.drawingId },
    update: { lastVisitedAt: new Date() },
  });

export const getDrawingVisit = async (params: {
  prisma: PrismaClient;
  userId: string;
  drawingId: string;
}): Promise<string | null> => {
  const row = await params.prisma.drawingVisit.findUnique({
    where: { userId_drawingId: { userId: params.userId, drawingId: params.drawingId } },
    select: { lastVisitedAt: true },
  });
  return row ? row.lastVisitedAt.toISOString() : null;
};

export const recordTeamActivityVisit = (params: { prisma: PrismaClient; userId: string }) =>
  params.prisma.teamActivityVisit.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId },
    update: { lastSeenAt: new Date() },
  });

export const getTeamActivityVisit = async (params: {
  prisma: PrismaClient;
  userId: string;
}): Promise<string | null> => {
  const row = await params.prisma.teamActivityVisit.findUnique({
    where: { userId: params.userId },
    select: { lastSeenAt: true },
  });
  return row ? row.lastSeenAt.toISOString() : null;
};
