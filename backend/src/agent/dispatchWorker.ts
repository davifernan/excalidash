import { canEditDrawing, getDrawingAccess } from "../authz/sharing";
import type { AgentRuntimeGateway } from "./runtime/gateway";
import {
  acknowledgeDispatchRuntime,
  claimDispatchOutbox,
  failDispatchBeforeRuntimeAck,
  loadDispatchForWorker,
  observeDispatchRuntime,
  type DispatchReceiptProjection,
} from "./dispatchReceipt";

type PrismaLike = any;

type RuntimeRequest = {
  connectionId: string;
  profileId: string;
  displayName: string;
  mountCapabilityToken: string;
  allowedContextIds: string[];
};

const parseStringArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const parseRuntimeRequest = (value: string | null | undefined): RuntimeRequest | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RuntimeRequest>;
    if (
      typeof parsed.connectionId !== "string" ||
      typeof parsed.profileId !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.mountCapabilityToken !== "string" ||
      !Array.isArray(parsed.allowedContextIds) ||
      !parsed.allowedContextIds.every((id) => typeof id === "string")
    ) {
      return null;
    }
    return parsed as RuntimeRequest;
  } catch {
    return null;
  }
};

/**
 * Performs the one allowed foreign start attempt. The outbox is claimed
 * before the call. A process failure after `gateway.start()` therefore leaves
 * `sending`, which reconciliation turns into outcome_unknown; it is never
 * retried and can never start a duplicate agent.
 */
export const processDispatchOutbox = async (params: {
  prisma: PrismaLike;
  gateway: AgentRuntimeGateway;
  dispatchId: string;
  now?: Date;
  onReceipt?: (receipt: DispatchReceiptProjection) => void;
  /** Test seam for the crash-after-foreign-start uncertainty boundary. */
  afterForeignStart?: () => Promise<void>;
}): Promise<DispatchReceiptProjection | null> => {
  const now = params.now ?? new Date();
  if (!(await claimDispatchOutbox({ prisma: params.prisma, dispatchId: params.dispatchId, now }))) {
    return null;
  }
  const dispatch = await loadDispatchForWorker({
    prisma: params.prisma,
    dispatchId: params.dispatchId,
  });
  const runtimeRequest = parseRuntimeRequest(dispatch?.outbox?.payload);
  if (!dispatch || !runtimeRequest) {
    return failDispatchBeforeRuntimeAck({
      prisma: params.prisma,
      dispatchId: params.dispatchId,
      reasonCode: "INVALID_OUTBOX_PAYLOAD",
      now,
    });
  }

  const principal = { kind: "user" as const, userId: dispatch.initiatedByUserId };
  const access = await getDrawingAccess({
    prisma: params.prisma,
    principal,
    drawingId: dispatch.drawingId,
  });
  if (!canEditDrawing(access)) {
    return failDispatchBeforeRuntimeAck({
      prisma: params.prisma,
      dispatchId: params.dispatchId,
      reasonCode: "BOARD_ACCESS_REVOKED",
      now,
    });
  }

  let started: Awaited<ReturnType<AgentRuntimeGateway["start"]>>;
  try {
    started = await params.gateway.start({
      drawingId: dispatch.drawingId,
      access,
      principal,
      connectionId: runtimeRequest.connectionId,
      profileId: runtimeRequest.profileId,
      displayName: runtimeRequest.displayName,
      initialPrompt: dispatch.objectiveSummary,
      approvedCapabilities: parseStringArray(dispatch.effectiveCapabilities),
      runId: dispatch.runId,
      dispatchId: dispatch.id,
      boardMount: {
        revisionId: dispatch.revisionId,
        capabilityToken: runtimeRequest.mountCapabilityToken,
        allowedContextIds: runtimeRequest.allowedContextIds,
      },
    });
  } catch {
    // A transport failure cannot prove the foreign runtime did not start.
    // Keep `sending`; the bounded server deadline will make the uncertainty
    // explicit instead of lying with either "failed" or "succeeded".
    return null;
  }
  await params.afterForeignStart?.();
  const acknowledged = await acknowledgeDispatchRuntime({
    prisma: params.prisma,
    dispatchId: dispatch.id,
    runtimeCapability: started.runCapability,
    runtimeStatus: started.run.status,
    now,
  });
  if (!acknowledged) return null;
  if (["done", "unknown"].includes(started.run.status)) return acknowledged;
  const observed =
    (await observeDispatchRuntime({
      prisma: params.prisma,
      dispatchId: dispatch.id,
      runtimeStatus: started.run.status,
      now,
    })) ?? acknowledged;

  // A long-lived runtime stream is useful evidence, but not authority. It
  // is re-authorized on every event and independently every 20 seconds;
  // losing access closes observation immediately. Stream closure itself is
  // never translated to success -- the bounded liveness reconciler decides
  // outcome_unknown if no explicit terminal state follows.
  void params.gateway
    .subscribe(
      {
        drawingId: dispatch.drawingId,
        access,
        principal,
        runCapability: started.runCapability,
      },
      (event) => {
        void getDrawingAccess({
          prisma: params.prisma,
          principal,
          drawingId: dispatch.drawingId,
        }).then(async (freshAccess) => {
          if (!canEditDrawing(freshAccess)) return;
          const next = await observeDispatchRuntime({
            prisma: params.prisma,
            dispatchId: dispatch.id,
            runtimeStatus: event.status,
          });
          if (next) params.onReceipt?.(next);
        });
      },
    )
    .then((subscription) => {
      const reauthorize = setInterval(() => {
        void getDrawingAccess({
          prisma: params.prisma,
          principal,
          drawingId: dispatch.drawingId,
        }).then((freshAccess) => {
          if (!canEditDrawing(freshAccess)) subscription.close();
        });
      }, 20_000);
      reauthorize.unref();
      void subscription.closed.finally(() => clearInterval(reauthorize));
    })
    .catch(() => undefined);
  return observed;
};
