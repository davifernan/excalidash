import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { readStoredBytes } from "../assets/assetStorage";
import { readWidgetRecord } from "../assets/customDataSchema";
import { decodeSnapshotField, encodeSnapshotField } from "../snapshots/snapshotCodec";
import {
  AGENT_ASSET_READ,
  AGENT_BOARD_EXPLORE,
  AGENT_BOARD_RENDER,
  AGENT_MOUNT_CAPABILITIES,
  type AgentMountCapability,
  canReadAgentContext,
  requireAgentMountCapability,
  resolveEffectiveAgentContextIds,
} from "../authz/agentContext";
import { resolveAgentContextContributePolicy } from "../authz/capabilities";
import { type ContextIdentity, contextFrameBounds, validateContextFrames } from "./boardContexts";
import { canonicalJson, secretsEqual, sha256Json, sha256Text } from "./canonicalJson";
import {
  isEligibleForAgentContribution,
  readElementGuestProvenance,
} from "./elementGuestProvenance";
import {
  boardAgentAudienceFromMount,
  boardAgentFocusTargetsFromResult,
  type BoardAgentFocusEvent,
  type BoardAgentRunAudience,
} from "./presence";

type Element = Record<string, any>;
type ContextSnapshot = ContextIdentity & { frameName: string | null };

export class AgentMountError extends Error {
  constructor(
    public readonly code:
      | "MOUNT_NOT_FOUND"
      | "INVALID_MOUNT_TOKEN"
      | "INVALID_TOOL_ARGUMENTS"
      | "ELEMENT_NOT_READABLE"
      | "FRAME_NOT_READABLE"
      | "ASSET_NOT_READABLE"
      | "ASSET_TOO_LARGE"
      | "ASSET_NO_LONGER_AVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "AgentMountError";
  }
}

export const AGENT_TOOL_NAMES = [
  "overview",
  "listContexts",
  "listFrames",
  "readFrame",
  "readElements",
  "search",
  "neighbors",
  "followEdge",
  "render",
  "readAsset",
  "revisionStatus",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const liveElements = (elements: unknown): Element[] =>
  Array.isArray(elements)
    ? elements.filter(
        (element): element is Element =>
          Boolean(element) &&
          typeof element === "object" &&
          typeof (element as Element).id === "string" &&
          (element as Element).isDeleted !== true,
      )
    : [];

const snapshotContexts = (
  contexts: readonly ContextIdentity[],
  frames: ReadonlyMap<string, Element>,
): ContextSnapshot[] =>
  contexts
    .map((context) => ({
      ...context,
      frameName:
        typeof frames.get(context.id)?.name === "string" ? frames.get(context.id)!.name : null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

export const materializeAgentBoardRevision = async (prisma: any, drawingId: string) => {
  let expectedContentHash: string | null = null;
  try {
    return await prisma.$transaction(async (tx: any) => {
      const drawing = await tx.drawing.findUnique({
        where: { id: drawingId },
        select: {
          version: true,
          elements: true,
          appState: true,
          files: true,
          assets: {
            where: { state: "ACTIVE" },
            select: {
              asset: {
                select: {
                  id: true,
                  kind: true,
                  originalName: true,
                  mimeType: true,
                  blob: { select: { sha256: true, sizeBytes: true } },
                },
              },
            },
          },
        },
      });
      if (!drawing) throw new AgentMountError("MOUNT_NOT_FOUND", "Drawing does not exist.");
      const contexts = (await tx.agentContext.findMany({
        where: { drawingId },
        select: { id: true, frameElementId: true, pinned: true },
      })) as ContextIdentity[];
      const elements = liveElements(parseJson<unknown[]>(drawing.elements, []));
      const frames = validateContextFrames(elements, contexts);
      const contextMap = snapshotContexts(contexts, frames);
      const assets = drawing.assets
        .map(({ asset }: any) => ({
          assetId: asset.id,
          contentHash: asset.blob.sha256,
          kind: asset.kind,
          originalName: asset.originalName,
          mimeType: asset.mimeType,
          sizeBytes: asset.blob.sizeBytes,
        }))
        .sort((left: any, right: any) => left.assetId.localeCompare(right.assetId));
      const parsedAppState = parseJson<Record<string, unknown>>(drawing.appState, {});
      const parsedFiles = parseJson<Record<string, unknown>>(drawing.files, {});
      const contentHash = sha256Json({
        elements,
        appState: parsedAppState,
        files: parsedFiles,
        contextMap,
        assets,
      });
      expectedContentHash = contentHash;
      const existing = await tx.agentBoardRevision.findUnique({
        where: { drawingId_contentHash: { drawingId, contentHash } },
      });
      if (existing) return existing;

      return tx.agentBoardRevision.create({
        data: {
          drawingId,
          sourceDrawingVersion: drawing.version,
          contentHash,
          elements: encodeSnapshotField(canonicalJson(elements), config.enableSnapshotCompression),
          appState: encodeSnapshotField(
            canonicalJson(parsedAppState),
            config.enableSnapshotCompression,
          ),
          files: encodeSnapshotField(canonicalJson(parsedFiles), config.enableSnapshotCompression),
          contextMap: canonicalJson(contextMap),
          assets: { create: assets },
        },
      });
    });
  } catch (error: any) {
    // Parallel read-only runs commonly mount the same board at once. Both may
    // compute the same immutable content before either inserts it; the unique
    // content key elects one winner and the loser reuses that exact revision.
    if (error?.code === "P2002" && expectedContentHash) {
      const winner = await prisma.agentBoardRevision.findUnique({
        where: { drawingId_contentHash: { drawingId, contentHash: expectedContentHash } },
      });
      if (winner) return winner;
    }
    throw error;
  }
};

export const createAgentRunMount = async (params: {
  prisma: any;
  drawingId: string;
  runId?: string;
  allowedContextIds?: string[];
  capabilities?: string[];
  displayName: string;
  audience: BoardAgentRunAudience;
}) => {
  const revision = await materializeAgentBoardRevision(params.prisma, params.drawingId);
  const contexts = parseJson<ContextSnapshot[]>(revision.contextMap, []);
  const allowedContextIds = resolveEffectiveAgentContextIds(
    params.allowedContextIds,
    contexts.map((context) => context.id),
  );
  const capabilities = params.capabilities ?? [...AGENT_MOUNT_CAPABILITIES];
  if (
    capabilities.length === 0 ||
    capabilities.some(
      (candidate) => !(AGENT_MOUNT_CAPABILITIES as readonly string[]).includes(candidate),
    )
  ) {
    throw new AgentMountError(
      "INVALID_TOOL_ARGUMENTS",
      "A mount must name only supported read capabilities.",
    );
  }
  const capabilityToken = `exd_mount_${randomBytes(32).toString("base64url")}`;
  const runId = params.runId ?? randomUUID();
  const mount = await params.prisma.agentRunMount.create({
    data: {
      runId,
      drawingId: params.drawingId,
      revisionId: revision.id,
      allowedContextIds: canonicalJson(allowedContextIds),
      capabilities: canonicalJson([...new Set(capabilities)].sort()),
      capabilityTokenHash: sha256Text(capabilityToken),
      displayName: params.displayName,
      audienceKind: params.audience.kind,
      audienceUserId: params.audience.kind === "private" ? params.audience.userId : null,
    },
  });
  return {
    runId: mount.runId,
    drawingId: mount.drawingId,
    revisionId: mount.revisionId,
    sourceDrawingVersion: revision.sourceDrawingVersion,
    allowedContextIds,
    capabilities: parseJson<string[]>(mount.capabilities, []),
    displayName: mount.displayName,
    visibility: mount.audienceKind,
    capabilityToken,
  };
};

export const loadBoardAgentRunPresence = async (prisma: any, drawingId: string, runId: string) => {
  const mount = await prisma.agentRunMount.findUnique({
    where: { runId },
    select: {
      runId: true,
      drawingId: true,
      revisionId: true,
      displayName: true,
      audienceKind: true,
      audienceUserId: true,
    },
  });
  if (!mount || mount.drawingId !== drawingId) return null;
  const audience = boardAgentAudienceFromMount(mount);
  return audience ? { ...mount, audience } : null;
};

const loadMountedScene = async (params: {
  prisma: any;
  drawingId: string;
  runId: string;
  capabilityToken: string;
}) => {
  const mount = await params.prisma.agentRunMount.findUnique({
    where: { runId: params.runId },
    include: {
      revision: {
        include: {
          // assetId is a historical pointer (see AgentBoardRevisionAsset's
          // schema comment), not a live foreign key, so the underlying Asset
          // is looked up lazily -- only readAsset({mode:"content"}) needs it,
          // and only when the live row still exists.
          assets: true,
        },
      },
    },
  });
  if (!mount || mount.drawingId !== params.drawingId) {
    throw new AgentMountError("MOUNT_NOT_FOUND", "Run mount does not exist.");
  }
  if (!secretsEqual(params.capabilityToken, mount.capabilityTokenHash)) {
    throw new AgentMountError("INVALID_MOUNT_TOKEN", "Run mount capability is invalid.");
  }
  return {
    mount,
    revision: mount.revision,
    elements: liveElements(parseJson<unknown[]>(decodeSnapshotField(mount.revision.elements), [])),
    files: parseJson<Record<string, any>>(decodeSnapshotField(mount.revision.files), {}),
    contexts: parseJson<ContextSnapshot[]>(mount.revision.contextMap, []),
    allowedContextIds: new Set(parseJson<string[]>(mount.allowedContextIds, [])),
    capabilities: parseJson<string[]>(mount.capabilities, []),
  };
};

const contextIndex = (elements: readonly Element[], contexts: readonly ContextSnapshot[]) => {
  const byId = new Map(elements.map((element) => [element.id as string, element]));
  const contextByFrame = new Map(contexts.map((context) => [context.frameElementId, context.id]));
  const cache = new Map<string, string | null>();
  const resolve = (element: Element): string | null => {
    if (cache.has(element.id)) return cache.get(element.id)!;
    const ownContext = contextByFrame.get(element.id);
    if (ownContext) {
      cache.set(element.id, ownContext);
      return ownContext;
    }
    let frameId = typeof element.frameId === "string" ? element.frameId : null;
    const visited = new Set<string>();
    while (frameId && !visited.has(frameId)) {
      visited.add(frameId);
      const contextId = contextByFrame.get(frameId);
      if (contextId) {
        cache.set(element.id, contextId);
        return contextId;
      }
      const frame = byId.get(frameId);
      frameId = frame && typeof frame.frameId === "string" ? frame.frameId : null;
    }
    cache.set(element.id, null);
    return null;
  };
  return { byId, resolve };
};

const numberOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const projectElement = (
  element: Element,
  allowedIds: ReadonlySet<string>,
  contextId: string,
  revisionAssetIds: ReadonlySet<string>,
) => {
  const readableId = (value: unknown): string | null =>
    typeof value === "string" && allowedIds.has(value) ? value : null;
  const widget = readWidgetRecord(element);
  const result: Record<string, unknown> = {
    id: element.id,
    type: typeof element.type === "string" ? element.type : "unknown",
    contextId,
    bounds: {
      x: numberOrZero(element.x),
      y: numberOrZero(element.y),
      width: numberOrZero(element.width),
      height: numberOrZero(element.height),
    },
    angle: numberOrZero(element.angle),
    frameId: readableId(element.frameId),
  };
  if (typeof element.text === "string") result.text = element.text;
  if (typeof element.link === "string") result.link = element.link;
  if (typeof element.containerId === "string") result.containerId = readableId(element.containerId);
  if (Array.isArray(element.boundElements)) {
    result.boundElementIds = element.boundElements
      .map((binding: any) => readableId(binding?.id))
      .filter((id: string | null): id is string => id !== null)
      .sort();
  }
  if (element.startBinding) result.startElementId = readableId(element.startBinding.elementId);
  if (element.endBinding) result.endElementId = readableId(element.endBinding.elementId);
  if (widget && revisionAssetIds.has(widget.assetId)) {
    result.asset = { id: widget.assetId, kind: widget.kind };
  }
  if (element.type === "arrow" || element.type === "line") {
    result.semantics = { kind: "unspecified" };
  }
  return result;
};

const integerArg = (args: Record<string, unknown>, name: string, fallback: number): number => {
  const value = args[name] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new AgentMountError("INVALID_TOOL_ARGUMENTS", `${name} must be a positive integer.`);
  }
  return value as number;
};

const boundedLimit = (args: Record<string, unknown>, fallback: number): number =>
  Math.min(integerArg(args, "limit", fallback), 100);

const stringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new AgentMountError("INVALID_TOOL_ARGUMENTS", `${name} must be a non-empty string.`);
  }
  return value;
};

const escapeXml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character]!;
  });

const renderSvg = (elements: readonly Element[]) => {
  if (elements.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  }
  const minX = Math.min(...elements.map((element) => numberOrZero(element.x)));
  const minY = Math.min(...elements.map((element) => numberOrZero(element.y)));
  const maxX = Math.max(
    ...elements.map((element) => numberOrZero(element.x) + Math.abs(numberOrZero(element.width))),
  );
  const maxY = Math.max(
    ...elements.map((element) => numberOrZero(element.y) + Math.abs(numberOrZero(element.height))),
  );
  const body = elements
    .map((element) => {
      const x = numberOrZero(element.x);
      const y = numberOrZero(element.y);
      const width = Math.max(1, Math.abs(numberOrZero(element.width)));
      const height = Math.max(1, Math.abs(numberOrZero(element.height)));
      if (element.type === "ellipse") {
        return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="none" stroke="#1b1b1f"/>`;
      }
      if (element.type === "text") {
        return `<text x="${x}" y="${y + Math.max(12, height)}" fill="#1b1b1f">${escapeXml(element.text)}</text>`;
      }
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#1b1b1f"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}">${body}</svg>`;
};

export const executeAgentBoardTool = async (params: {
  prisma: any;
  drawingId: string;
  runId: string;
  capabilityToken: string;
  tool: AgentToolName;
  args?: Record<string, unknown>;
  onFocus?: (event: BoardAgentFocusEvent) => void;
}) => {
  const scene = await loadMountedScene(params);
  const args = params.args ?? {};
  const { byId, resolve } = contextIndex(scene.elements, scene.contexts);
  const inAllowedContext = scene.elements.filter((element) =>
    canReadAgentContext(scene.allowedContextIds, resolve(element)),
  );
  // NIL-677 Gate 2: a Context-readable element still only contributes if its
  // guest provenance clears isEligibleForAgentContribution. Batched once per
  // tool call, not per element -- every tool below reads from the same
  // allowedElements, so this is the single chokepoint, not N lookups. The
  // exact same policy read Gate 1 (assertGuestElementWriteAllowed) uses --
  // see resolveAgentContextContributePolicy's own comment for why neither
  // gate may carry its own copy of "is this on". Skipped entirely when
  // nothing is Context-readable in the first place (no registered Context,
  // or none in this mount's allowedContextIds) -- the common case for most
  // tool calls, and Gate 1 already makes the same early exit for the same
  // reason.
  const agentContextContributeEnabled =
    inAllowedContext.length > 0
      ? await resolveAgentContextContributePolicy(params.prisma, params.drawingId)
      : false;
  const provenance =
    inAllowedContext.length > 0
      ? await readElementGuestProvenance(
          params.prisma,
          params.drawingId,
          inAllowedContext.map((element) => element.id as string),
        )
      : [];
  const provenanceByElementId = new Map(provenance.map((entry) => [entry.elementId, entry.status]));
  // A Context's own frame is the boundary marker, not admitted content --
  // registration conservatively backfills its provenance the same as any
  // other pre-existing element in the frame (boardContexts.ts's
  // elementIdsInContextFrame includes the frame itself), so a frame with no
  // confirmed-clean row would otherwise become unreadable and break every
  // tool that needs to resolve it, including ones that never expose its
  // content. Gate 2 protects content leaving the frame, not whether the
  // frame boundary itself can be addressed.
  const contextFrameElementIds = new Set(scene.contexts.map((context) => context.frameElementId));
  // Not just a log line: registerAgentContext (boardContexts.ts) backfills
  // EVERY element without a provenance row as guest-touched the moment an
  // existing frame is registered, whether or not a guest was ever near it --
  // so on a board with real history, this filter can silently drop most of
  // its content the first time anything actually reads through it. A tool
  // result that only shows what survived, with no sign anything was cut,
  // lets an agent answer confidently from a board it never fully saw. The
  // count below is the minimum an agent needs to know its own view is
  // incomplete -- not which elements, not their content, just that some
  // exist and were withheld.
  let excludedElementCount = 0;
  const allowedElements = inAllowedContext.filter((element) => {
    if (contextFrameElementIds.has(element.id as string)) return true;
    const status = provenanceByElementId.get(element.id as string) ?? "unknown";
    const eligible = isEligibleForAgentContribution({ status, agentContextContributeEnabled });
    if (!eligible) {
      excludedElementCount += 1;
      // Not proof that Gate 1 (assertGuestElementWriteAllowed) was bypassed
      // -- an ordinary member drag of old, never-confirmed content into the
      // frame produces the exact same status, and Gate 1 never restricts
      // members. Still worth surfacing rather than silently filtering: this
      // is the one place a human can see that Gate 2 is actually doing
      // something, not just agreeing with Gate 1 by construction.
      logger.warn("NIL-677 Gate 2 excluded a Context-readable element from Agent Context", {
        drawingId: params.drawingId,
        runId: params.runId,
        elementId: element.id,
        contextId: resolve(element),
        provenanceStatus: status,
      });
    }
    return eligible;
  });
  const allowedElementIds = new Set(allowedElements.map((element) => element.id as string));
  const revisionAssetIds = new Set<string>(
    scene.revision.assets.map((asset: any) => String(asset.assetId)),
  );
  const project = (element: Element) =>
    projectElement(element, allowedElementIds, resolve(element)!, revisionAssetIds);
  const requireReadableElement = (
    id: string,
    code: "ELEMENT_NOT_READABLE" | "FRAME_NOT_READABLE",
  ) => {
    const element = byId.get(id);
    if (!element || !allowedElementIds.has(id)) {
      throw new AgentMountError(code, "The requested element is not readable in this mount.");
    }
    return element;
  };
  let deferredFocusFallbackTargets: readonly string[] = [];
  const requestedFocusTargets = (): readonly string[] => {
    switch (params.tool) {
      case "readFrame":
        return [requireReadableElement(stringArg(args, "frameElementId"), "FRAME_NOT_READABLE").id];
      case "readElements":
        if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.length > 100) return [];
        return args.ids
          .map((id) => requireReadableElement(String(id), "ELEMENT_NOT_READABLE"))
          .map((element) => element.id);
      case "neighbors": {
        const source = requireReadableElement(stringArg(args, "elementId"), "ELEMENT_NOT_READABLE");
        deferredFocusFallbackTargets = [source.id];
        return [];
      }
      case "followEdge": {
        const edge = requireReadableElement(
          stringArg(args, "edgeElementId"),
          "ELEMENT_NOT_READABLE",
        );
        deferredFocusFallbackTargets = [edge.id];
        return [];
      }
      case "render": {
        if (typeof args.contextId !== "string" || args.contextId.length === 0) return [];
        if (!scene.allowedContextIds.has(args.contextId)) {
          throw new AgentMountError("FRAME_NOT_READABLE", "The requested Context is not readable.");
        }
        const context = scene.contexts.find((candidate) => candidate.id === args.contextId);
        return context ? [context.frameElementId] : [];
      }
      default:
        return [];
    }
  };
  const audience = boardAgentAudienceFromMount(scene.mount);
  const emitFocus = (phase: "started" | "finished", targetIds: readonly string[]) => {
    if (!audience || !params.onFocus || targetIds.length === 0) return;
    params.onFocus({
      phase,
      agentId: scene.mount.runId,
      runId: scene.mount.runId,
      drawingId: scene.mount.drawingId,
      revisionId: scene.revision.id,
      displayName: scene.mount.displayName,
      targetIds: [...new Set(targetIds)].slice(0, 50),
      audience,
      occurredAt: new Date().toISOString(),
    });
  };
  let result: unknown;

  if (params.tool === "render") requireAgentMountCapability(scene.capabilities, AGENT_BOARD_RENDER);
  else if (params.tool === "readAsset")
    requireAgentMountCapability(scene.capabilities, AGENT_ASSET_READ);
  else requireAgentMountCapability(scene.capabilities, AGENT_BOARD_EXPLORE);

  let focusTargets = requestedFocusTargets();
  let focusStarted = focusTargets.length > 0;
  if (focusStarted) emitFocus("started", focusTargets);

  try {
    switch (params.tool) {
      case "overview": {
        const countsByType: Record<string, number> = {};
        for (const element of allowedElements) {
          const type = typeof element.type === "string" ? element.type : "unknown";
          countsByType[type] = (countsByType[type] ?? 0) + 1;
        }
        result = {
          contextCount: scene.contexts.filter((context) => scene.allowedContextIds.has(context.id))
            .length,
          elementCount: allowedElements.length,
          countsByType,
        };
        break;
      }
      case "listContexts":
        result = scene.contexts
          .filter((context) => scene.allowedContextIds.has(context.id))
          .map((context) => ({
            contextId: context.id,
            frameElementId: context.frameElementId,
            name: context.frameName,
            pinned: context.pinned,
            bounds: contextFrameBounds(byId.get(context.frameElementId)!)!,
          }));
        break;
      case "listFrames":
        result = allowedElements
          .filter((element) => element.type === "frame")
          .slice(0, boundedLimit(args, 100))
          .map(project);
        break;
      case "readFrame": {
        const frame = requireReadableElement(
          stringArg(args, "frameElementId"),
          "FRAME_NOT_READABLE",
        );
        if (frame.type !== "frame") {
          throw new AgentMountError("FRAME_NOT_READABLE", "The requested element is not a frame.");
        }
        const contextId = resolve(frame)!;
        result = {
          frame: project(frame),
          elements: allowedElements
            .filter((element) => element.id !== frame.id && resolve(element) === contextId)
            .slice(0, boundedLimit(args, 100))
            .map(project),
        };
        break;
      }
      case "readElements": {
        if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.length > 100) {
          throw new AgentMountError(
            "INVALID_TOOL_ARGUMENTS",
            "ids must contain between one and 100 element ids.",
          );
        }
        result = args.ids.map((id) =>
          project(requireReadableElement(String(id), "ELEMENT_NOT_READABLE")),
        );
        break;
      }
      case "search": {
        const query = stringArg(args, "query").toLocaleLowerCase();
        const limit = boundedLimit(args, 20);
        result = allowedElements
          .filter(
            (element) =>
              (typeof element.text === "string" &&
                element.text.toLocaleLowerCase().includes(query)) ||
              (typeof element.name === "string" &&
                element.name.toLocaleLowerCase().includes(query)),
          )
          .slice(0, limit)
          .map(project);
        break;
      }
      case "neighbors": {
        const source = requireReadableElement(stringArg(args, "elementId"), "ELEMENT_NOT_READABLE");
        const related = new Set<string>();
        for (const candidate of [source.containerId, source.frameId]) {
          if (typeof candidate === "string" && allowedElementIds.has(candidate))
            related.add(candidate);
        }
        for (const binding of Array.isArray(source.boundElements) ? source.boundElements : []) {
          if (typeof binding?.id === "string" && allowedElementIds.has(binding.id))
            related.add(binding.id);
        }
        for (const element of allowedElements) {
          if (
            element.startBinding?.elementId === source.id ||
            element.endBinding?.elementId === source.id ||
            element.containerId === source.id
          ) {
            related.add(element.id);
          }
        }
        result = [...related]
          .sort()
          .slice(0, boundedLimit(args, 100))
          .map((id) => project(byId.get(id)!));
        break;
      }
      case "followEdge": {
        const edge = requireReadableElement(
          stringArg(args, "edgeElementId"),
          "ELEMENT_NOT_READABLE",
        );
        if (edge.type !== "arrow" && edge.type !== "line") {
          throw new AgentMountError(
            "INVALID_TOOL_ARGUMENTS",
            "The requested element is not an edge.",
          );
        }
        const endpoint = (binding: any) => {
          const id = typeof binding?.elementId === "string" ? binding.elementId : null;
          return id && allowedElementIds.has(id) ? project(byId.get(id)!) : null;
        };
        result = {
          edge: project(edge),
          semantics: { kind: "unspecified" },
          start: endpoint(edge.startBinding),
          end: endpoint(edge.endBinding),
        };
        break;
      }
      case "render": {
        const requestedContext =
          typeof args.contextId === "string" && args.contextId.length > 0 ? args.contextId : null;
        if (requestedContext && !scene.allowedContextIds.has(requestedContext)) {
          throw new AgentMountError("FRAME_NOT_READABLE", "The requested Context is not readable.");
        }
        const renderedElements = requestedContext
          ? allowedElements.filter((element) => resolve(element) === requestedContext)
          : allowedElements;
        const referencedAssetIds = new Set(
          renderedElements
            .map((element) => readWidgetRecord(element)?.assetId)
            .filter((id): id is string => Boolean(id)),
        );
        const assetHashes = scene.revision.assets
          .filter((asset: any) => referencedAssetIds.has(asset.assetId))
          .map((asset: any) => ({ assetId: asset.assetId, sha256: asset.contentHash }))
          .concat(
            renderedElements.flatMap((element) => {
              const fileId = typeof element.fileId === "string" ? element.fileId : null;
              return fileId && scene.files[fileId]
                ? [{ assetId: `file:${fileId}`, sha256: sha256Json(scene.files[fileId]) }]
                : [];
            }),
          )
          .sort((left: any, right: any) => left.assetId.localeCompare(right.assetId));
        result = { rendererVersion: "agent-svg-v1", assetHashes, svg: renderSvg(renderedElements) };
        break;
      }
      case "readAsset": {
        const assetId = stringArg(args, "assetId");
        const referencedByReadableElement = allowedElements.some(
          (element) => readWidgetRecord(element)?.assetId === assetId,
        );
        const revisionAsset = scene.revision.assets.find((asset: any) => asset.assetId === assetId);
        if (!referencedByReadableElement || !revisionAsset) {
          throw new AgentMountError("ASSET_NOT_READABLE", "The requested asset is not readable.");
        }
        const mode = args.mode ?? "metadata";
        if (mode !== "metadata" && mode !== "content") {
          throw new AgentMountError("INVALID_TOOL_ARGUMENTS", "mode must be metadata or content.");
        }
        const metadata = {
          assetId,
          kind: revisionAsset.kind,
          name: revisionAsset.originalName,
          mimeType: revisionAsset.mimeType,
          sizeBytes: revisionAsset.sizeBytes,
          sha256: revisionAsset.contentHash,
        };
        if (mode === "metadata") {
          result = metadata;
          break;
        }
        if (revisionAsset.sizeBytes > 1024 * 1024) {
          throw new AgentMountError(
            "ASSET_TOO_LARGE",
            "Asset content exceeds the 1 MiB tool limit.",
          );
        }
        // assetId is a historical pointer, not an enforced foreign key (see the
        // AgentBoardRevisionAsset schema comment): the asset the revision once
        // captured may have since been reclaimed by the ordinary cleanup job.
        // Metadata above never needed the live row; only fetching bytes does.
        const liveAsset = await params.prisma.asset.findUnique({
          where: { id: assetId },
          select: { blob: { select: { storageKey: true, contentEncoding: true } } },
        });
        if (!liveAsset) {
          throw new AgentMountError(
            "ASSET_NO_LONGER_AVAILABLE",
            "This revision recorded the asset, but it no longer exists.",
          );
        }
        const bytes = await readStoredBytes(config.assets.storageDir, liveAsset.blob);
        if (createHash("sha256").update(bytes).digest("hex") !== revisionAsset.contentHash) {
          throw new AgentMountError("ASSET_NOT_READABLE", "Mounted asset bytes no longer match.");
        }
        result = {
          ...metadata,
          encoding: revisionAsset.mimeType.startsWith("text/") ? "utf8" : "base64",
          content: revisionAsset.mimeType.startsWith("text/")
            ? bytes.toString("utf8")
            : bytes.toString("base64"),
        };
        break;
      }
      case "revisionStatus": {
        const latest = await materializeAgentBoardRevision(params.prisma, params.drawingId);
        if (latest.id === scene.revision.id) {
          result = { changed: false, latestRevisionId: scene.revision.id };
          break;
        }
        const latestElements = liveElements(
          parseJson<unknown[]>(decodeSnapshotField(latest.elements), []),
        );
        const latestContexts = parseJson<ContextSnapshot[]>(latest.contextMap, []);
        const latestIndex = contextIndex(latestElements, latestContexts);
        const scoped = latestElements.filter((element) =>
          canReadAgentContext(scene.allowedContextIds, latestIndex.resolve(element)),
        );
        const countsByType: Record<string, number> = {};
        for (const element of scoped) {
          const type = typeof element.type === "string" ? element.type : "unknown";
          countsByType[type] = (countsByType[type] ?? 0) + 1;
        }
        result = {
          changed: true,
          latestRevisionId: latest.id,
          sourceDrawingVersion: latest.sourceDrawingVersion,
          scopedSummary: { elementCount: scoped.length, countsByType },
        };
        break;
      }
    }

    const projectedTargets = boardAgentFocusTargetsFromResult(params.tool, result);
    const resolvedFocusTargets =
      projectedTargets.length > 0 ? projectedTargets : deferredFocusFallbackTargets;
    if (!focusStarted && resolvedFocusTargets.length > 0) {
      focusTargets = resolvedFocusTargets;
      focusStarted = true;
      emitFocus("started", focusTargets);
    }
    const resultHash = sha256Json(result);
    await params.prisma.agentToolAudit.create({
      data: {
        runId: scene.mount.runId,
        revisionId: scene.revision.id,
        tool: params.tool,
        argsHash: sha256Json(args),
        resultHash,
      },
    });
    if (focusStarted) emitFocus("finished", focusTargets);
    return {
      runId: scene.mount.runId,
      revisionId: scene.revision.id,
      tool: params.tool,
      resultHash,
      result,
      // The count, not the ids or content -- see excludedElementCount's own
      // comment above for why this must never be silently absent. Outside
      // resultHash on purpose: this is a fact about the mount's provenance
      // state at call time, not part of the tool's own answer, and it must
      // not perturb the audit hash of that answer.
      excludedElementCount,
    };
  } catch (error) {
    if (!focusStarted && deferredFocusFallbackTargets.length > 0) {
      focusTargets = deferredFocusFallbackTargets;
      focusStarted = true;
      emitFocus("started", focusTargets);
    }
    if (focusStarted) emitFocus("finished", focusTargets);
    throw error;
  }
};

export const isAgentToolName = (value: string): value is AgentToolName =>
  (AGENT_TOOL_NAMES as readonly string[]).includes(value);

export const supportedAgentCapabilities = (): readonly AgentMountCapability[] =>
  AGENT_MOUNT_CAPABILITIES;
