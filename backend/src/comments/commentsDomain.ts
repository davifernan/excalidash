import type { Prisma, PrismaClient } from "../generated/client";
import { sanitizeText } from "../security";
import { getDrawingRosters } from "../authz/roster";
import { extractMentionedUserIds } from "./mentions";

export const COMMENT_BODY_MAX_LENGTH = 4000;

export type CommentDTO = {
  id: string;
  drawingId: string;
  rootId: string | null;
  authorUserId: string;
  authorName: string;
  body: string | null;
  elementId: string | null;
  anchorX: number | null;
  anchorY: number | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  mentionedUserIds: string[];
  createdAt: string;
  updatedAt: string;
};

const COMMENT_SELECT = {
  id: true,
  drawingId: true,
  rootId: true,
  authorUserId: true,
  author: { select: { name: true } },
  body: true,
  elementId: true,
  anchorX: true,
  anchorY: true,
  resolvedAt: true,
  resolvedByUserId: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  mentions: { select: { mentionedUserId: true } },
} satisfies Prisma.CommentSelect;

type RawComment = Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>;

const toDTO = (row: RawComment): CommentDTO => ({
  id: row.id,
  drawingId: row.drawingId,
  rootId: row.rootId,
  authorUserId: row.authorUserId,
  authorName: row.author.name,
  // A deleted comment's body is not returned; a tombstone must not keep
  // leaking what was said, only that something was said and by whom.
  body: row.deletedAt ? null : row.body,
  elementId: row.elementId,
  anchorX: row.anchorX,
  anchorY: row.anchorY,
  resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  resolvedByUserId: row.resolvedByUserId,
  editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  mentionedUserIds: row.deletedAt ? [] : row.mentions.map((m) => m.mentionedUserId),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class CommentDomainError extends Error {
  constructor(
    public readonly code:
      "not-found" | "not-a-root" | "forbidden" | "invalid-body" | "invalid-anchor",
    message: string,
  ) {
    super(message);
  }
}

/** Board members who may be @mentioned, for the picker. Never link guests. */
export const listMentionCandidates = async (params: { prisma: PrismaClient; drawingId: string }) =>
  (await getDrawingRosters({ prisma: params.prisma, drawingIds: [params.drawingId] })).get(
    params.drawingId,
  ) ?? [];

export const listComments = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  includeResolved: boolean;
}): Promise<CommentDTO[]> => {
  const rows = await params.prisma.comment.findMany({
    where: {
      drawingId: params.drawingId,
      ...(params.includeResolved
        ? {}
        : {
            OR: [{ rootId: { not: null } }, { resolvedAt: null }],
          }),
    },
    select: COMMENT_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toDTO);
};

const validateAnchor = (
  anchorX: unknown,
  anchorY: unknown,
): { x: number | null; y: number | null } => {
  const hasX = anchorX !== undefined && anchorX !== null;
  const hasY = anchorY !== undefined && anchorY !== null;
  if (!hasX && !hasY) return { x: null, y: null };
  if (
    !hasX ||
    !hasY ||
    typeof anchorX !== "number" ||
    typeof anchorY !== "number" ||
    !Number.isFinite(anchorX) ||
    !Number.isFinite(anchorY)
  ) {
    throw new CommentDomainError(
      "invalid-anchor",
      "anchorX and anchorY must both be finite numbers",
    );
  }
  return { x: anchorX, y: anchorY };
};

/**
 * Create a comment (or a reply), atomically with its mentions and the one
 * activity event both the feed and notifications read.
 *
 * Mentions are re-resolved against the board roster here, never trusted from
 * the request: `extractMentionedUserIds` only reads ids out of the body, and
 * an id with no standing claim on this board is silently dropped rather than
 * turned into a notification that leaks the board's existence to it.
 */
export const createComment = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  authorUserId: string;
  rawBody: unknown;
  rootId?: string | null;
  elementId?: string | null;
  anchorX?: unknown;
  anchorY?: unknown;
}): Promise<{
  comment: CommentDTO;
  activityEventId: string;
  recipients: { userId: string; kind: "mention" | "reply" }[];
}> => {
  const body = sanitizeText(params.rawBody, COMMENT_BODY_MAX_LENGTH).trim();
  if (!body) throw new CommentDomainError("invalid-body", "Comment body must not be empty");

  const anchor = validateAnchor(params.anchorX, params.anchorY);
  const elementId =
    typeof params.elementId === "string" && params.elementId.trim().length > 0
      ? params.elementId.trim().slice(0, 200)
      : null;

  let root: { id: string; rootId: string | null; drawingId: string } | null = null;
  if (params.rootId) {
    const candidate = await params.prisma.comment.findUnique({
      where: { id: params.rootId },
      select: { id: true, rootId: true, drawingId: true, deletedAt: true },
    });
    if (!candidate || candidate.drawingId !== params.drawingId) {
      throw new CommentDomainError("not-found", "Thread not found on this board");
    }
    if (candidate.rootId !== null) {
      throw new CommentDomainError(
        "not-a-root",
        "Replies must target a thread root, not another reply",
      );
    }
    root = candidate;
  }

  const roster = await listMentionCandidates({
    prisma: params.prisma,
    drawingId: params.drawingId,
  });
  const rosterIds = new Set(roster.map((member) => member.userId));
  const mentionedUserIds = extractMentionedUserIds(body).filter(
    (id) => rosterIds.has(id) && id !== params.authorUserId,
  );

  // Existing thread participants (root author + everyone who has replied),
  // for the "someone answered in a thread you are part of" notification.
  // Computed before the insert so the author's own new row cannot count as
  // "already participating".
  const participantRows = root
    ? await params.prisma.comment.findMany({
        where: { OR: [{ id: root.id }, { rootId: root.id }], deletedAt: null },
        select: { authorUserId: true },
        distinct: ["authorUserId"],
      })
    : [];
  const replyRecipients = participantRows
    .map((row) => row.authorUserId)
    .filter((userId) => userId !== params.authorUserId && !mentionedUserIds.includes(userId));

  const summary = body.length > 140 ? `${body.slice(0, 140)}...` : body;

  const created = await params.prisma.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        drawingId: params.drawingId,
        rootId: root?.id ?? null,
        authorUserId: params.authorUserId,
        body,
        elementId,
        anchorX: anchor.x,
        anchorY: anchor.y,
      },
      select: COMMENT_SELECT,
    });

    // upsert rather than createMany+skipDuplicates: SQLite's Prisma client
    // does not support skipDuplicates at all (Postgres/MySQL only), and this
    // needs to run identically against both providers.
    for (const mentionedUserId of mentionedUserIds) {
      await tx.mention.upsert({
        where: { commentId_mentionedUserId: { commentId: comment.id, mentionedUserId } },
        create: { commentId: comment.id, mentionedUserId },
        update: {},
      });
    }

    const event = await tx.activityEvent.create({
      data: {
        drawingId: params.drawingId,
        actorUserId: params.authorUserId,
        verb: root ? "comment.replied" : "comment.created",
        commentId: comment.id,
        elementId: comment.elementId,
        anchorX: comment.anchorX,
        anchorY: comment.anchorY,
        summary,
      },
      select: { id: true },
    });

    const recipients = [
      ...mentionedUserIds.map((userId) => ({ userId, kind: "mention" as const })),
      ...replyRecipients.map((userId) => ({ userId, kind: "reply" as const })),
    ];
    for (const recipient of recipients) {
      await tx.notification.upsert({
        where: {
          recipientUserId_activityEventId: {
            recipientUserId: recipient.userId,
            activityEventId: event.id,
          },
        },
        create: {
          recipientUserId: recipient.userId,
          activityEventId: event.id,
          kind: recipient.kind,
        },
        update: {},
      });
    }

    // Re-select rather than reuse the earlier `comment`: that select ran
    // before the Mention rows existed, so its `mentions` relation would
    // still read back empty even though the rows are now there.
    const withMentions = await tx.comment.findUniqueOrThrow({
      where: { id: comment.id },
      select: COMMENT_SELECT,
    });
    return { comment: withMentions, activityEventId: event.id, recipients };
  });

  return {
    comment: toDTO(created.comment),
    activityEventId: created.activityEventId,
    recipients: created.recipients,
  };
};

export const editComment = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  commentId: string;
  actorUserId: string;
  rawBody: unknown;
}): Promise<{
  comment: CommentDTO;
  activityEventId: string | null;
  recipients: { userId: string; kind: "mention" }[];
}> => {
  const existing = await params.prisma.comment.findUnique({
    where: { id: params.commentId },
    select: { id: true, drawingId: true, authorUserId: true, deletedAt: true, rootId: true },
  });
  if (!existing || existing.drawingId !== params.drawingId || existing.deletedAt) {
    throw new CommentDomainError("not-found", "Comment not found");
  }
  // Editing is strictly the author's own voice. Board editors may delete an
  // out-of-line comment (moderation) but must not rewrite someone else's words.
  if (existing.authorUserId !== params.actorUserId) {
    throw new CommentDomainError("forbidden", "Only the author may edit this comment");
  }
  const body = sanitizeText(params.rawBody, COMMENT_BODY_MAX_LENGTH).trim();
  if (!body) throw new CommentDomainError("invalid-body", "Comment body must not be empty");

  const roster = await listMentionCandidates({
    prisma: params.prisma,
    drawingId: params.drawingId,
  });
  const rosterIds = new Set(roster.map((member) => member.userId));
  const mentionedUserIds = extractMentionedUserIds(body).filter(
    (id) => rosterIds.has(id) && id !== params.actorUserId,
  );
  const summary = body.length > 140 ? `${body.slice(0, 140)}...` : body;

  const updated = await params.prisma.$transaction(async (tx) => {
    const comment = await tx.comment.update({
      where: { id: params.commentId },
      data: { body, editedAt: new Date() },
      select: COMMENT_SELECT,
    });

    const existingMentions = await tx.mention.findMany({
      where: { commentId: params.commentId },
      select: { mentionedUserId: true },
    });
    const existingMentionIds = new Set(existingMentions.map((m) => m.mentionedUserId));
    const newlyMentioned = mentionedUserIds.filter((id) => !existingMentionIds.has(id));
    let activityEventId: string | null = null;
    if (newlyMentioned.length > 0) {
      for (const mentionedUserId of newlyMentioned) {
        await tx.mention.upsert({
          where: { commentId_mentionedUserId: { commentId: comment.id, mentionedUserId } },
          create: { commentId: comment.id, mentionedUserId },
          update: {},
        });
      }
      const event = await tx.activityEvent.create({
        data: {
          drawingId: params.drawingId,
          actorUserId: params.actorUserId,
          verb: "comment.edited",
          commentId: comment.id,
          elementId: comment.elementId,
          anchorX: comment.anchorX,
          anchorY: comment.anchorY,
          summary,
        },
        select: { id: true },
      });
      activityEventId = event.id;
      for (const userId of newlyMentioned) {
        await tx.notification.upsert({
          where: {
            recipientUserId_activityEventId: { recipientUserId: userId, activityEventId: event.id },
          },
          create: { recipientUserId: userId, activityEventId: event.id, kind: "mention" as const },
          update: {},
        });
      }
    }

    return { comment, activityEventId, newlyMentioned };
  });

  return {
    comment: toDTO(updated.comment),
    activityEventId: updated.activityEventId,
    recipients: updated.newlyMentioned.map((userId) => ({ userId, kind: "mention" as const })),
  };
};

/** Author, or anyone with edit-level board access (moderation). */
export const deleteComment = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  commentId: string;
  actorUserId: string;
  actorCanModerate: boolean;
}): Promise<void> => {
  const existing = await params.prisma.comment.findUnique({
    where: { id: params.commentId },
    select: { id: true, drawingId: true, authorUserId: true, deletedAt: true },
  });
  if (!existing || existing.drawingId !== params.drawingId || existing.deletedAt) {
    throw new CommentDomainError("not-found", "Comment not found");
  }
  if (existing.authorUserId !== params.actorUserId && !params.actorCanModerate) {
    throw new CommentDomainError("forbidden", "Not allowed to delete this comment");
  }
  await params.prisma.$transaction(async (tx) => {
    await tx.comment.update({
      where: { id: params.commentId },
      data: { deletedAt: new Date(), deletedByUserId: params.actorUserId, body: "" },
    });
    await tx.activityEvent.create({
      data: {
        drawingId: params.drawingId,
        actorUserId: params.actorUserId,
        verb: "comment.deleted",
        commentId: existing.id,
        summary: "Comment deleted",
      },
    });
  });
};

const setResolution = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  rootId: string;
  actorUserId: string;
  resolve: boolean;
}): Promise<{
  comment: CommentDTO;
  activityEventId: string | null;
  recipients: { userId: string; kind: "resolve" | "reopen" }[];
}> => {
  const root = await params.prisma.comment.findUnique({
    where: { id: params.rootId },
    select: { id: true, drawingId: true, rootId: true, deletedAt: true, resolvedAt: true },
  });
  if (!root || root.drawingId !== params.drawingId || root.deletedAt) {
    throw new CommentDomainError("not-found", "Thread not found");
  }
  if (root.rootId !== null) {
    throw new CommentDomainError("not-a-root", "Only a thread root can be resolved or reopened");
  }
  if (params.resolve === Boolean(root.resolvedAt)) {
    // Already in the requested state: idempotent no-op, no duplicate event.
    const current = await params.prisma.comment.findUniqueOrThrow({
      where: { id: params.rootId },
      select: COMMENT_SELECT,
    });
    return { comment: toDTO(current), activityEventId: null, recipients: [] };
  }

  const participantRows = await params.prisma.comment.findMany({
    where: { OR: [{ id: root.id }, { rootId: root.id }], deletedAt: null },
    select: { authorUserId: true },
    distinct: ["authorUserId"],
  });
  const recipients = participantRows
    .map((row) => row.authorUserId)
    .filter((userId) => userId !== params.actorUserId);

  const updated = await params.prisma.$transaction(async (tx) => {
    const comment = await tx.comment.update({
      where: { id: params.rootId },
      data: params.resolve
        ? { resolvedAt: new Date(), resolvedByUserId: params.actorUserId }
        : { resolvedAt: null, resolvedByUserId: null },
      select: COMMENT_SELECT,
    });
    const event = await tx.activityEvent.create({
      data: {
        drawingId: params.drawingId,
        actorUserId: params.actorUserId,
        verb: params.resolve ? "comment.resolved" : "comment.reopened",
        commentId: comment.id,
        elementId: comment.elementId,
        anchorX: comment.anchorX,
        anchorY: comment.anchorY,
        summary: params.resolve ? "Thread resolved" : "Thread reopened",
      },
      select: { id: true },
    });
    for (const userId of recipients) {
      await tx.notification.upsert({
        where: {
          recipientUserId_activityEventId: { recipientUserId: userId, activityEventId: event.id },
        },
        create: {
          recipientUserId: userId,
          activityEventId: event.id,
          kind: params.resolve ? ("resolve" as const) : ("reopen" as const),
        },
        update: {},
      });
    }
    return { comment, activityEventId: event.id };
  });

  return {
    comment: toDTO(updated.comment),
    activityEventId: updated.activityEventId,
    recipients: recipients.map((userId) => ({
      userId,
      kind: params.resolve ? ("resolve" as const) : ("reopen" as const),
    })),
  };
};

export const resolveThread = (params: {
  prisma: PrismaClient;
  drawingId: string;
  rootId: string;
  actorUserId: string;
}) => setResolution({ ...params, resolve: true });

export const reopenThread = (params: {
  prisma: PrismaClient;
  drawingId: string;
  rootId: string;
  actorUserId: string;
}) => setResolution({ ...params, resolve: false });

/**
 * Hand every comment (and comment-authored activity event) this account
 * wrote to a successor, the same shape as reassignGrantAuthorshipOps
 * (authz/grants.ts) and for the same reason userOffboarding.ts already
 * calls that one: it must run before `tx.user.delete(...)`, in the same
 * transaction, not after.
 *
 * Unlike a share grant's createdByUserId, Comment.authorUserId and
 * ActivityEvent.actorUserId are real relations with onDelete: Cascade --
 * `author` has to be a real account for every row (no anonymous
 * authorship), which a nullable/SetNull field would quietly relax. Cascade
 * is correct for a board or a single comment being deleted on purpose. It
 * is wrong for offboarding: Comment.root also cascades, so an offboarded
 * author's own root comment disappearing would silently take every OTHER
 * person's reply nested under it with it. Reassigning first means the
 * delete never finds a Comment or ActivityEvent still pointing at the
 * departing account, so neither cascade ever fires here.
 */
export const reassignCommentAuthorshipOps = (params: {
  prisma: Prisma.TransactionClient;
  fromUserId: string;
  toUserId: string;
}) => [
  params.prisma.comment.updateMany({
    where: { authorUserId: params.fromUserId },
    data: { authorUserId: params.toUserId },
  }),
  params.prisma.activityEvent.updateMany({
    where: { actorUserId: params.fromUserId },
    data: { actorUserId: params.toUserId },
  }),
];
