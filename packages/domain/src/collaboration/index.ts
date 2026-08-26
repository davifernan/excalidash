import { z } from "zod";

export const sceneBoundsSchema = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .readonly();
export type SceneBounds = z.infer<typeof sceneBoundsSchema>;

export const roomEventErrorSchema = z.object({ code: z.string(), message: z.string() });
export type RoomEventError = z.infer<typeof roomEventErrorSchema>;
export type CommandOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: RoomEventError };

export const collaborationEvents = {
  cursorMove: "cursor-move",
  cursorChat: "cursor-chat",
  documentAssetReplaced: "document-asset-replaced",
  elementUpdate: "element-update",
  followCommand: "follow-user",
  followStatus: "follow-status",
  followedByUpdate: "followed-by-update",
  inviteHere: "invite-here",
  inviteHereResponse: "invite-here-response",
  inviteHereStatus: "invite-here-status",
  joinRoom: "join-room",
  leaveRoom: "leave-room",
  presenceUpdate: "presence-update",
  documentEditLockCommand: "document-edit-lock-command",
  documentEditLockUpdate: "document-edit-lock-update",
  documentEditLockGranted: "document-edit-lock-granted",
  documentPageCommand: "document-page-command",
  documentPageUpdate: "document-page-update",
  drawingNameUpdate: "drawing-name-update",
  presenterCommand: "presenter-command",
  presenterViewport: "presenter-viewport",
  presenterState: "presenter-state",
  presenterNotes: "presenter-notes",
  presenterNotesSet: "presenter-notes-set",
  selectionUpdate: "selection-update",
  selectionSnapshot: "selection-snapshot",
  votingCommand: "voting-command",
  votingCast: "voting-cast",
  votingState: "voting-state",
  workshopTimerCommand: "workshop-timer-command",
  workshopTimerUpdate: "workshop-timer-update",
  userActivity: "user-activity",
  viewportBounds: "viewport-bounds",
} as const;

export const drawingIdSchema = z.string().trim().min(1).max(200);

export const presenceIdentitySchema = z.object({
  presenceId: z.string().min(1),
  name: z.string(),
  initials: z.string().default(""),
  color: z.string(),
  isActive: z.boolean(),
});
export type PresenceIdentity = z.infer<typeof presenceIdentitySchema>;
export const presenceSnapshotSchema = z.array(presenceIdentitySchema);
export const clientIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  color: z.string(),
});
export const joinRoomRequestSchema = z.object({
  drawingId: drawingIdSchema,
  shareToken: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  user: clientIdentitySchema.partial().default({}),
});
export const joinRoomAckSchema = z.union([
  z.object({
    ok: z.literal(true).optional(),
    presence: z.object({ presenceId: z.string().min(1) }).passthrough(),
  }),
  z.object({ ok: z.literal(false), error: roomEventErrorSchema }),
]);
export const leaveRoomRequestSchema = z.object({ drawingId: drawingIdSchema });

export const cursorPointerSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  tool: z.enum(["pointer", "laser"]),
});
export const cursorUpdateSchema = z.object({
  drawingId: drawingIdSchema,
  pointer: cursorPointerSchema,
  button: z.enum(["up", "down"]).default("up"),
});
export type CursorUpdate = z.infer<typeof cursorUpdateSchema>;
export const remoteCursorUpdateSchema = z.object({
  drawingId: drawingIdSchema.optional(),
  presenceId: z.string().min(1),
  pointer: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    tool: z.enum(["pointer", "laser"]).optional(),
  }),
  button: z.enum(["up", "down"]).default("up"),
  username: z.string(),
  color: z.string(),
});
export type RemoteCursorUpdate = z.infer<typeof remoteCursorUpdateSchema>;

export const followSceneBoundsSchema = sceneBoundsSchema.refine(
  ([x1, y1, x2, y2]) => x2 > x1 && y2 > y1,
);
export type FollowSceneBounds = z.infer<typeof followSceneBoundsSchema>;
export const followerSchema = z.object({ presenceId: z.string().min(1), name: z.string() });
export type Follower = z.infer<typeof followerSchema>;
export const followCommandSchema = z.discriminatedUnion("action", [
  z.object({
    drawingId: drawingIdSchema,
    action: z.literal("FOLLOW"),
    targetPresenceId: z.string().min(1).max(200),
  }),
  z.object({
    drawingId: drawingIdSchema,
    action: z.literal("UNFOLLOW"),
    targetPresenceId: z.string().optional(),
  }),
]);
export type FollowCommand = z.infer<typeof followCommandSchema>;
export const followedByUpdateSchema = z.object({
  drawingId: drawingIdSchema,
  followers: z.array(followerSchema),
});
export const followStatusSchema = z.object({
  drawingId: drawingIdSchema,
  followingPresenceId: z.string().nullable(),
  reason: z.string().optional(),
});
export const viewportBoundsInputSchema = z.object({
  drawingId: drawingIdSchema,
  sceneBounds: followSceneBoundsSchema,
});
export const viewportBoundsUpdateSchema = viewportBoundsInputSchema.extend({
  presenceId: z.string().min(1),
  sequence: z.number().int().positive(),
});

export const inviteHereRequestSchema = viewportBoundsInputSchema;
export const inviteHereDecisionSchema = z.enum(["accepted", "declined"]);
export const inviteHereResponseSchema = z.object({
  drawingId: drawingIdSchema,
  invitationId: z.string().min(1).max(100),
  decision: inviteHereDecisionSchema,
});
export const viewportInvitationSchema = z.object({
  drawingId: drawingIdSchema,
  invitationId: z.string().min(1),
  inviterPresenceId: z.string().min(1),
  inviterName: z.string(),
  sceneBounds: followSceneBoundsSchema,
  expiresAt: z.number().finite().positive(),
});
export type ViewportInvitation = Omit<z.infer<typeof viewportInvitationSchema>, "drawingId">;
export const inviteHereStatusSchema = z.object({
  drawingId: drawingIdSchema,
  invitationId: z.string().min(1),
  arrivedCount: z.number().int().nonnegative(),
  expiresAt: z.number().finite().positive(),
});
export type InviteHereStatus = Omit<z.infer<typeof inviteHereStatusSchema>, "drawingId">;

export const remoteSelectionUpdateSchema = z.union([
  z.object({
    drawingId: drawingIdSchema,
    presenceId: z.string().min(1),
    selectedElementIds: z.array(z.string()),
  }),
  z.object({
    drawingId: drawingIdSchema,
    presenceId: z.string().min(1),
    allSelected: z.literal(true),
  }),
]);
export const selectionSnapshotSchema = z.array(
  z.union([
    z.object({ presenceId: z.string().min(1), selectedElementIds: z.array(z.string()) }),
    z.object({ presenceId: z.string().min(1), allSelected: z.literal(true) }),
  ]),
);
export const selectionSnapshotUpdateSchema = z.object({
  drawingId: drawingIdSchema,
  selections: selectionSnapshotSchema,
});

export const userActivitySchema = z.object({ drawingId: drawingIdSchema, isActive: z.boolean() });

export const workshopTimerStatusSchema = z.enum(["idle", "running", "paused", "finished"]);
export type WorkshopTimerStatus = z.infer<typeof workshopTimerStatusSchema>;
export const workshopTimerActionSchema = z.enum([
  "start",
  "restart",
  "pause",
  "resume",
  "stop",
  "add-minute",
]);
export type WorkshopTimerAction = z.infer<typeof workshopTimerActionSchema>;
export const workshopTimerSnapshotSchema = z.object({
  drawingId: z.string().min(1),
  status: workshopTimerStatusSchema,
  endsAt: z.number().finite().nonnegative().nullable(),
  remainingMs: z.number().finite().nonnegative(),
  durationMs: z.number().int().positive().nullable(),
  serverNow: z.number().finite().nonnegative(),
});
export type WorkshopTimerSnapshot = z.infer<typeof workshopTimerSnapshotSchema>;

export const presenterStatusSchema = z.enum(["idle", "presenting"]);
export type PresenterStatus = z.infer<typeof presenterStatusSchema>;
export const presenterSnapshotSchema = z.object({
  drawingId: z.string().min(1),
  status: presenterStatusSchema,
  presenterPresenceId: z.string().nullable().default(null),
  presenterName: z.string().nullable().default(null),
  frameId: z.string().nullable().default(null),
  bounds: sceneBoundsSchema.nullable().default(null),
  revision: z.number().finite().nonnegative().default(0),
});
export type PresenterSnapshot = z.infer<typeof presenterSnapshotSchema>;
export const presenterNotesSchema = z.object({
  drawingId: z.string().min(1),
  frameId: z.string().nullable(),
  text: z.string(),
});
export type PresenterNotes = Omit<z.infer<typeof presenterNotesSchema>, "drawingId">;

export const voteOptionSchema = z.object({ id: z.string(), label: z.string() });
export type VoteOption = z.infer<typeof voteOptionSchema>;
export const votingStatusSchema = z.enum(["idle", "open", "revealed"]);
export type VotingStatus = z.infer<typeof votingStatusSchema>;
export const votingSnapshotSchema = z.object({
  drawingId: z.string().min(1),
  status: votingStatusSchema,
  roundId: z.string().nullable().default(null),
  prompt: z.string().nullable().default(null),
  options: z.array(voteOptionSchema).readonly().nullable().default(null),
  maxSelections: z.number().finite().nullable().default(null),
  tally: z.record(z.string(), z.number().finite()).readonly().nullable().default(null),
  participantCount: z.number().finite().nullable().default(null),
});
export type VotingSnapshot = z.infer<typeof votingSnapshotSchema>;

export const publicDocumentEditLockSchema = z.object({
  assetId: z.string(),
  presenceId: z.string(),
  ownerName: z.string(),
});
export type PublicDocumentEditLock = z.infer<typeof publicDocumentEditLockSchema>;
export const documentEditLockSchema = publicDocumentEditLockSchema.extend({
  drawingId: z.string(),
  token: z.string(),
});
export type DocumentEditLock = z.infer<typeof documentEditLockSchema>;
export const documentEditLockSnapshotSchema = z.object({
  drawingId: z.string(),
  locks: z.array(z.unknown()),
});

export const sharedDocumentPageSchema = z.object({
  page: z.number().int().min(1),
  revision: z.number().int().nonnegative(),
});
export type SharedDocumentPage = z.infer<typeof sharedDocumentPageSchema>;
export const documentPageUpdateEntrySchema = sharedDocumentPageSchema.extend({
  elementId: z.string().min(1),
});
export const documentPageEntrySchema = documentPageUpdateEntrySchema.extend({
  assetId: z.string().min(1),
});
export type DocumentPageEntry = z.infer<typeof documentPageEntrySchema>;
export const documentPageSnapshotSchema = z.object({
  drawingId: z.string(),
  pages: z.array(z.unknown()),
});

export const drawingNameUpdateSchema = z.object({
  drawingId: z.string(),
  name: z.string().min(1).max(255),
  revision: z.number().int().min(1),
});
export type DrawingNameUpdate = z.infer<typeof drawingNameUpdateSchema>;

export const documentAssetReplacementSchema = z.object({
  drawingId: z.string(),
  previousAssetId: z.string(),
  assetId: z.string(),
  drawingVersion: z.number().int().nonnegative(),
  elements: z.array(z.record(z.string(), z.unknown())),
});
export type DocumentAssetReplacement = z.infer<typeof documentAssetReplacementSchema>;

export const selectionPayloadSchema = z.union([
  z.object({ selectedElementIds: z.array(z.string()) }),
  z.object({ allSelected: z.literal(true) }),
]);
export type SelectionPayload = z.infer<typeof selectionPayloadSchema>;
export const REMOTE_SELECTION_PAYLOAD_BYTES = 256 * 1024;
export const CURSOR_CHAT_MAX_LENGTH = 140;

export const elementUpdatePayloadSchema = z.object({
  drawingId: z.string(),
  elements: z.array(z.record(z.string(), z.unknown())),
  files: z.record(z.string(), z.unknown()).optional(),
  elementOrder: z.array(z.string()).optional(),
  elementOrderOmittedBytes: z.number().int().nonnegative().optional(),
});
export type ElementUpdatePayload = z.infer<typeof elementUpdatePayloadSchema>;
export const remoteElementUpdateSchema = elementUpdatePayloadSchema.omit({ drawingId: true });
