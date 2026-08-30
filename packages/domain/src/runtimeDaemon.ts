import { z } from "zod";

export const RUNTIME_DAEMON_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_DAEMON_MAX_COMMAND_BYTES = 64 * 1024;

export const runtimeDaemonProfileSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(120),
});

export const runtimeDaemonStatusSchema = z.enum(["working", "idle", "blocked", "done", "unknown"]);

const runtimeDaemonMountSchema = z.object({
  revisionId: z.string().min(1).max(128),
  capabilityToken: z.string().min(1).max(16_384),
  allowedContextIds: z.array(z.string().min(1).max(128)).max(100),
});

export const runtimeDaemonCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion: z.literal(RUNTIME_DAEMON_PROTOCOL_VERSION),
    commandId: z.string().uuid(),
    kind: z.literal("start"),
    payload: z.object({
      profileId: z.string().min(1).max(128),
      displayName: z.string().min(1).max(80),
      initialPrompt: z.string().max(20_000).optional(),
      runId: z.string().min(1).max(128),
      drawingId: z.string().min(1).max(128),
      dispatchId: z.string().min(1).max(128).optional(),
      boardMount: runtimeDaemonMountSchema.optional(),
    }),
  }),
  z.object({
    protocolVersion: z.literal(RUNTIME_DAEMON_PROTOCOL_VERSION),
    commandId: z.string().uuid(),
    kind: z.literal("prompt"),
    payload: z.object({
      runtimeHandle: z.string().min(1).max(4_096),
      text: z.string().min(1).max(20_000),
    }),
  }),
  z.object({
    protocolVersion: z.literal(RUNTIME_DAEMON_PROTOCOL_VERSION),
    commandId: z.string().uuid(),
    kind: z.literal("status"),
    payload: z.object({ runtimeHandle: z.string().min(1).max(4_096) }),
  }),
]);

export type RuntimeDaemonCommand = z.infer<typeof runtimeDaemonCommandSchema>;

export const runtimeDaemonCommandResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    runtimeHandle: z.string().min(1).max(4_096).optional(),
    status: runtimeDaemonStatusSchema,
    displayName: z.string().min(1).max(80).optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "PROFILE_NOT_FOUND",
      "EXECUTOR_UNAVAILABLE",
      "EXECUTOR_REJECTED",
      "REQUEST_FAILED",
    ]),
  }),
]);

export type RuntimeDaemonCommandResult = z.infer<typeof runtimeDaemonCommandResultSchema>;

export const runtimeDaemonStatusEventSchema = z.object({
  runtimeHandle: z.string().min(1).max(4_096),
  status: runtimeDaemonStatusSchema,
  displayName: z.string().min(1).max(80).optional(),
});

export type RuntimeDaemonStatusEvent = z.infer<typeof runtimeDaemonStatusEventSchema>;
