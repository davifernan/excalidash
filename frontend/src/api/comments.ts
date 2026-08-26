import { api } from "./client";
import {
  activityResponseSchema,
  commentResponseSchema,
  drawingActivityResponseSchema,
  drawingCommentsResponseSchema,
  inboxResponseSchema,
  mentionCandidatesResponseSchema,
  type ActivityEventDTO,
  type CommentDTO,
  type MentionCandidate,
  type NotificationDTO,
} from "@excalidash/domain/shared";

export type { ActivityEventDTO, CommentDTO, NotificationDTO } from "@excalidash/domain/shared";

export type { MentionCandidate } from "@excalidash/domain/shared";

export const getDrawingComments = async (
  drawingId: string,
  options?: { includeResolved?: boolean },
): Promise<{ comments: CommentDTO[]; canComment: boolean }> => {
  const response = await api.get(`/drawings/${drawingId}/comments`, {
    params: options?.includeResolved ? { includeResolved: "true" } : undefined,
  });
  return drawingCommentsResponseSchema.parse(response.data);
};

export const getMentionCandidates = async (drawingId: string): Promise<MentionCandidate[]> => {
  const response = await api.get<{ candidates: MentionCandidate[] }>(
    `/drawings/${drawingId}/comments/mention-candidates`,
  );
  return mentionCandidatesResponseSchema.parse(response.data).candidates;
};

export const createComment = async (
  drawingId: string,
  params: {
    body: string;
    rootId?: string | null;
    elementId?: string | null;
    anchorX?: number;
    anchorY?: number;
  },
): Promise<CommentDTO> => {
  const response = await api.post<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments`,
    params,
  );
  return commentResponseSchema.parse(response.data).comment;
};

export const editComment = async (
  drawingId: string,
  commentId: string,
  body: string,
): Promise<CommentDTO> => {
  const response = await api.patch<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments/${commentId}`,
    { body },
  );
  return commentResponseSchema.parse(response.data).comment;
};

export const deleteComment = async (drawingId: string, commentId: string): Promise<void> => {
  await api.delete(`/drawings/${drawingId}/comments/${commentId}`);
};

export const resolveComment = async (drawingId: string, commentId: string): Promise<CommentDTO> => {
  const response = await api.post<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments/${commentId}/resolve`,
  );
  return commentResponseSchema.parse(response.data).comment;
};

export const reopenComment = async (drawingId: string, commentId: string): Promise<CommentDTO> => {
  const response = await api.post<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments/${commentId}/reopen`,
  );
  return commentResponseSchema.parse(response.data).comment;
};

export const getInbox = async (options?: {
  unreadOnly?: boolean;
  before?: string | null;
}): Promise<{
  notifications: NotificationDTO[];
  unreadCount: number;
  lastSeenAt: string | null;
}> => {
  const response = await api.get("/inbox", {
    params: {
      ...(options?.unreadOnly ? { unreadOnly: "true" } : {}),
      ...(options?.before ? { before: options.before } : {}),
    },
  });
  return inboxResponseSchema.parse(response.data);
};

export const markNotificationRead = async (notificationId: string): Promise<void> => {
  await api.post(`/inbox/${notificationId}/read`);
};

export const markAllNotificationsRead = async (): Promise<void> => {
  await api.post("/inbox/read-all");
};

export const visitActivityFeed = async (): Promise<void> => {
  await api.post("/inbox/visit-activity");
};

export const getTeamActivity = async (options?: {
  before?: string | null;
}): Promise<{ events: ActivityEventDTO[] }> => {
  const response = await api.get("/activity", {
    params: options?.before ? { before: options.before } : undefined,
  });
  return activityResponseSchema.parse(response.data);
};

export const getDrawingActivity = async (
  drawingId: string,
  options?: { before?: string | null },
): Promise<{ events: ActivityEventDTO[]; lastVisitedAt: string | null }> => {
  const response = await api.get(`/drawings/${drawingId}/activity`, {
    params: options?.before ? { before: options.before } : undefined,
  });
  return drawingActivityResponseSchema.parse(response.data);
};

export const recordDrawingVisit = async (drawingId: string): Promise<void> => {
  await api.post(`/drawings/${drawingId}/visit`);
};
