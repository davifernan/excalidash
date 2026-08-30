import express from "express";
import { z } from "zod";
import {
  runtimeDaemonCommandResultSchema,
  runtimeDaemonProfileSchema,
  runtimeDaemonStatusEventSchema,
} from "@excalidash/domain";
import { AgentRuntimeError } from "./contracts";
import { RuntimeDaemonBroker } from "./runtimeDaemonBroker";
import {
  RuntimeDaemonService,
  RuntimeDaemonServiceError,
  runtimeDaemonCredentialFromRequest,
} from "./runtimeDaemonService";

const profilesSchema = z.array(runtimeDaemonProfileSchema).min(1).max(20);
const limitsSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(80),
      value: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .refine((value) => !/[$€£¥]|\b(?:USD|EUR|GBP|JPY)\b/i.test(value), {
          message: "Monetary amounts require an authoritative consumption source",
        }),
    }),
  )
  .max(20)
  .optional();
const daemonIdentitySchema = z.object({
  daemonVersion: z.string().trim().min(1).max(64),
  profiles: profilesSchema,
  planLabel: z.string().trim().min(1).max(120).optional(),
  limits: limitsSchema,
});
const pairingExchangeSchema = daemonIdentitySchema.extend({
  pairingCode: z.string().min(32).max(256),
});
const sessionSchema = daemonIdentitySchema;
const epochSchema = z.object({ epoch: z.number().int().positive() });
const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command-result"),
    epoch: z.number().int().positive(),
    commandId: z.string().uuid(),
    result: runtimeDaemonCommandResultSchema,
  }),
  z.object({
    kind: z.literal("status"),
    epoch: z.number().int().positive(),
    event: runtimeDaemonStatusEventSchema,
  }),
]);

type AsyncHandler = <T = void>(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<T>,
) => express.RequestHandler;

const daemonError = (res: express.Response, error: unknown) => {
  if (error instanceof RuntimeDaemonServiceError) {
    const status =
      error.code === "DAEMON_VERSION_UNSUPPORTED" || error.code === "DAEMON_VERSION_INVALID"
        ? 426
        : error.code === "SESSION_FENCED"
          ? 409
          : 401;
    return res.status(status).json({ code: error.code, message: error.message });
  }
  if (error instanceof AgentRuntimeError) {
    return res.status(error.code === "RUNTIME_NOT_CONNECTED" ? 409 : 422).json({
      code: error.code,
      message: error.message,
    });
  }
  return res
    .status(400)
    .json({ code: "RUNTIME_DAEMON_REQUEST_INVALID", message: "Invalid request" });
};

const credentialOrReject = (req: express.Request, res: express.Response): string | null => {
  const credential = runtimeDaemonCredentialFromRequest(req.headers.authorization);
  if (credential) return credential;
  res.status(401).json({
    code: "DEVICE_CREDENTIAL_INVALID",
    message: "A runtime daemon credential is required.",
  });
  return null;
};

/**
 * Machine endpoints are registered before browser CSRF middleware. They have
 * no ambient cookie authority: pairing consumes a one-use secret, and every
 * later request requires the revocable device bearer credential.
 */
export const registerRuntimeDaemonPublicRoutes = (
  app: express.Express,
  deps: { service: RuntimeDaemonService; broker: RuntimeDaemonBroker; asyncHandler: AsyncHandler },
) => {
  app.post(
    "/agent/runtime-daemons/pair",
    deps.asyncHandler(async (req, res) => {
      const parsed = pairingExchangeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: "RUNTIME_DAEMON_REQUEST_INVALID",
          message: "Invalid pairing request.",
        });
      }
      try {
        const paired = await deps.service.exchangePairing(parsed.data);
        return res.status(201).json({
          credential: paired.credential,
          daemonId: paired.daemon.id,
          minimumVersion: deps.service.minimumVersion,
        });
      } catch (error) {
        return daemonError(res, error);
      }
    }),
  );

  app.post(
    "/agent/runtime-daemons/session",
    deps.asyncHandler(async (req, res) => {
      const credential = credentialOrReject(req, res);
      if (!credential) return;
      const parsed = sessionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: "RUNTIME_DAEMON_REQUEST_INVALID",
          message: "Invalid daemon session request.",
        });
      }
      try {
        const daemon = await deps.service.openSession({ credential, ...parsed.data });
        deps.broker.activate(daemon);
        return res.status(201).json({
          daemonId: daemon.id,
          epoch: daemon.sessionEpoch,
          minimumVersion: deps.service.minimumVersion,
        });
      } catch (error) {
        return daemonError(res, error);
      }
    }),
  );

  app.post(
    "/agent/runtime-daemons/commands/next",
    deps.asyncHandler(async (req, res) => {
      const credential = credentialOrReject(req, res);
      if (!credential) return;
      const parsed = epochSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: "RUNTIME_DAEMON_REQUEST_INVALID",
          message: "Invalid daemon poll request.",
        });
      }
      try {
        const daemon = await deps.service.touchSession({
          credential,
          epoch: parsed.data.epoch,
        });
        const command = await deps.broker.poll(daemon.id, daemon.sessionEpoch);
        return command ? res.json({ command }) : res.status(204).end();
      } catch (error) {
        return daemonError(res, error);
      }
    }),
  );

  app.post(
    "/agent/runtime-daemons/events",
    deps.asyncHandler(async (req, res) => {
      const credential = credentialOrReject(req, res);
      if (!credential) return;
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: "RUNTIME_DAEMON_REQUEST_INVALID",
          message: "Invalid runtime daemon event.",
        });
      }
      try {
        const daemon = await deps.service.touchSession({
          credential,
          epoch: parsed.data.epoch,
        });
        if (parsed.data.kind === "command-result") {
          deps.broker.complete(
            daemon.id,
            daemon.sessionEpoch,
            parsed.data.commandId,
            parsed.data.result,
          );
        } else {
          deps.broker.publishStatus(daemon.id, daemon.sessionEpoch, parsed.data.event);
        }
        return res.status(202).json({ accepted: true });
      } catch (error) {
        return daemonError(res, error);
      }
    }),
  );
};

export const registerRuntimeDaemonManagementRoutes = (
  app: express.Express,
  deps: {
    service: RuntimeDaemonService;
    broker: RuntimeDaemonBroker;
    requireAuth: express.RequestHandler;
    asyncHandler: AsyncHandler;
  },
) => {
  app.post(
    "/agent/runtime-daemons/pairings",
    deps.requireAuth,
    deps.asyncHandler(async (req, res) => {
      const parsed = z.object({ label: z.string().trim().min(1).max(120) }).safeParse(req.body);
      if (!parsed.success || !req.user?.id) {
        return res.status(400).json({ error: "Invalid pairing request" });
      }
      return res.status(201).json(
        await deps.service.createPairing({
          ownerUserId: req.user.id,
          label: parsed.data.label,
        }),
      );
    }),
  );

  app.get(
    "/agent/runtime-daemons",
    deps.requireAuth,
    deps.asyncHandler(async (req, res) => {
      if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
      return res.json({ daemons: await deps.service.list(req.user.id) });
    }),
  );

  app.delete(
    "/agent/runtime-daemons/:daemonId",
    deps.requireAuth,
    deps.asyncHandler(async (req, res) => {
      if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
      const revoked = await deps.service.revoke(req.user.id, req.params.daemonId);
      if (!revoked) return res.status(404).json({ error: "Runtime daemon not found" });
      deps.broker.revoke(req.params.daemonId);
      return res.status(204).end();
    }),
  );
};
