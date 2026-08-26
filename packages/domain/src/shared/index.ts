import { z } from "zod";
export * from "./presence";

export const drawingPermissionSchema = z.enum(["view", "comment", "edit"]);
export type DrawingPermission = z.infer<typeof drawingPermissionSchema>;
export const drawingAccessSchema = z.enum(["none", "view", "comment", "edit", "owner"]);
export type DrawingAccess = z.infer<typeof drawingAccessSchema>;
export const collectionShareRoleSchema = z.enum(["view", "edit"]);
export type CollectionShareRole = z.infer<typeof collectionShareRoleSchema>;

export const drawingSortFieldSchema = z.enum(["name", "createdAt", "updatedAt"]);
export type DrawingSortField = z.infer<typeof drawingSortFieldSchema>;
export const sortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const passwordPolicySchema = z
  .object({
    minLength: z.number().int().positive(),
    maxLength: z.number().int().positive(),
    requireUppercase: z.boolean(),
    requireLowercase: z.boolean(),
    requireNumber: z.boolean(),
    requireSymbol: z.boolean(),
  })
  .refine((policy) => policy.maxLength >= policy.minLength);
export type PasswordPolicy = z.infer<typeof passwordPolicySchema>;

export const DEFAULT_API_KEY_SCOPES = [
  "drawings:read",
  "drawings:write",
  "collections:read",
  "collections:write",
] as const;
export const apiKeyScopeSchema = z.enum(DEFAULT_API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const authUserSchema = z.object({
  id: z.string(),
  username: z.string().nullable().optional(),
  email: z.string(),
  name: z.string(),
  role: z.string().optional(),
  mustResetPassword: z.boolean().optional(),
  impersonatorId: z.string().optional(),
});
export type AuthUser = z.infer<typeof authUserSchema>;
export const authStatusSchema = z.object({
  authEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
  registrationEnabled: z.boolean().optional(),
  passwordResetEnabled: z.boolean().optional(),
  authMode: z.enum(["local", "hybrid", "oidc_enforced"]).optional(),
  oidcEnabled: z.boolean().optional(),
  oidcEnforced: z.boolean().optional(),
  oidcProvider: z.string().optional(),
  oidcJitProvisioningEnabled: z.boolean().optional(),
  bootstrapRequired: z.boolean().optional(),
  authOnboardingRequired: z.boolean().optional(),
  authOnboardingMode: z.enum(["migration", "fresh"]).optional(),
  authOnboardingRecommended: z.literal("enable").nullable().optional(),
  passwordPolicy: passwordPolicySchema.optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const commentSchema = z.object({
  id: z.string(),
  drawingId: z.string(),
  rootId: z.string().nullable(),
  authorUserId: z.string(),
  authorName: z.string(),
  body: z.string().nullable(),
  elementId: z.string().nullable(),
  anchorX: z.number().nullable(),
  anchorY: z.number().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedByUserId: z.string().nullable(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  mentionedUserIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommentDTO = z.infer<typeof commentSchema>;

export const activityEventSchema = z.object({
  id: z.string(),
  drawingId: z.string(),
  drawingName: z.string(),
  actorUserId: z.string(),
  actorName: z.string(),
  verb: z.string(),
  commentId: z.string().nullable(),
  threadRootId: z.string().nullable(),
  elementId: z.string().nullable(),
  anchorX: z.number().nullable(),
  anchorY: z.number().nullable(),
  summary: z.string(),
  createdAt: z.string(),
});
export type ActivityEventDTO = z.infer<typeof activityEventSchema>;
export const notificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
  event: activityEventSchema,
});
export type NotificationDTO = z.infer<typeof notificationSchema>;
export const drawingCommentsResponseSchema = z.object({
  comments: z.array(commentSchema),
  canComment: z.boolean(),
});
export const commentResponseSchema = z.object({ comment: commentSchema });
export const mentionCandidateSchema = z.object({ userId: z.string(), name: z.string() });
export const mentionCandidatesResponseSchema = z.object({
  candidates: z.array(mentionCandidateSchema),
});
export type MentionCandidate = z.infer<typeof mentionCandidateSchema>;
export const inboxResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
  lastSeenAt: z.string().nullable(),
});
export const activityResponseSchema = z.object({ events: z.array(activityEventSchema) });
export const drawingActivityResponseSchema = activityResponseSchema.extend({
  lastVisitedAt: z.string().nullable(),
});

export const updateChannelSchema = z.enum(["stable", "prerelease"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export const updateInfoSchema = z.object({
  currentVersion: z.string().nullable(),
  channel: updateChannelSchema,
  outboundEnabled: z.boolean(),
  latestVersion: z.string().nullable(),
  latestUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  isUpdateAvailable: z.boolean().nullable(),
  error: z.string().optional(),
});
export type UpdateInfo = z.infer<typeof updateInfoSchema>;

export const drawingMemberSchema = z.object({
  subjectKey: z.string(),
  name: z.string(),
  initials: z.string(),
  color: z.string(),
  kind: z.enum(["owner", "member"]),
  isSelf: z.boolean(),
});
export type DrawingMember = z.infer<typeof drawingMemberSchema>;

export const mentionTokenPattern = /@\[([^\]\n]{1,120})\]\(([0-9a-fA-F-]{8,64})\)/g;
export const mentionToken = (name: string, userId: string): string => `@[${name}](${userId})`;

export const safeTelemetryTokenSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
export const logFieldsSchema = z.record(z.string(), z.unknown());
export type LogFields = z.infer<typeof logFieldsSchema>;
export const isSafeTelemetryToken = (value: unknown): value is string =>
  safeTelemetryTokenSchema.safeParse(value).success;
export const structuredLogReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
