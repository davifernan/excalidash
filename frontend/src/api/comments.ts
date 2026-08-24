import { api } from "./client";

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

export type MentionCandidate = { userId: string; name: string };

export type ActivityEventDTO = {
  id: string;
  drawingId: string;
  drawingName: string;
  actorUserId: string;
  actorName: string;
  verb: string;
  commentId: string | null;
  /** The thread root id to deep-link to -- see backend activityFeed.ts. */
  threadRootId: string | null;
  elementId: string | null;
  anchorX: number | null;
  anchorY: number | null;
  summary: string;
  createdAt: string;
};

export type NotificationDTO = {
  id: string;
  kind: string;
  readAt: string | null;
  createdAt: string;
  event: ActivityEventDTO;
};

export const getDrawingComments = async (
  drawingId: string,
  options?: { includeResolved?: boolean },
): Promise<{ comments: CommentDTO[]; canComment: boolean }> => {
  const response = await api.get(`/drawings/${drawingId}/comments`, {
    params: options?.includeResolved ? { includeResolved: "true" } : undefined,
  });
  return response.data;
};

export const getMentionCandidates = async (drawingId: string): Promise<MentionCandidate[]> => {
  const response = await api.get<{ candidates: MentionCandidate[] }>(
    `/drawings/${drawingId}/comments/mention-candidates`,
  );
  return response.data.candidates;
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
  return response.data.comment;
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
  return response.data.comment;
};

export const deleteComment = async (drawingId: string, commentId: string): Promise<void> => {
  await api.delete(`/drawings/${drawingId}/comments/${commentId}`);
};

export const resolveComment = async (drawingId: string, commentId: string): Promise<CommentDTO> => {
  const response = await api.post<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments/${commentId}/resolve`,
  );
  return response.data.comment;
};

export const reopenComment = async (drawingId: string, commentId: string): Promise<CommentDTO> => {
  const response = await api.post<{ comment: CommentDTO }>(
    `/drawings/${drawingId}/comments/${commentId}/reopen`,
  );
  return response.data.comment;
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
  return response.data;
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
  return response.data;
};

export const getDrawingActivity = async (
  drawingId: string,
  options?: { before?: string | null },
): Promise<{ events: ActivityEventDTO[]; lastVisitedAt: string | null }> => {
  const response = await api.get(`/drawings/${drawingId}/activity`, {
    params: options?.before ? { before: options.before } : undefined,
  });
  return response.data;
};

export const recordDrawingVisit = async (drawingId: string): Promise<void> => {
  await api.post(`/drawings/${drawingId}/visit`);
};
