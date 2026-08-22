import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { storeBlob } from "../assets/assetService";
import { freeDiskPercent } from "../assets/pageCache";
import { BoundedTaskQueue } from "../utils/boundedTaskQueue";
import type { LinkPreviewConfig } from "../config";
import {
  evictLinkPreviewCache,
  freshCached,
  previewDiskBytes,
  replaceCachedRow,
  type LinkPreviewCacheDeps,
} from "./cache";
import { sanitizePreviewImage, type ImageLimits } from "./imageProcessor";
import { extractLinkMetadata } from "./metadata";
import {
  fetchPreviewResource,
  PreviewFetchError,
  type PreviewNetworkDeps,
  type PreviewNetworkLimits,
} from "./network";

/**
 * How long a failed preview takes to answer, at the very least.
 *
 * Long enough that everything which fails quickly — a blocked private address,
 * a name that does not exist, a refused connection — is timed alike.
 */
export const FAILURE_FLOOR_MS = 2_000;

type ServiceDeps = LinkPreviewCacheDeps & {
  fetchResource?: typeof fetchPreviewResource;
  sanitizeImage?: typeof sanitizePreviewImage;
  networkDeps?: PreviewNetworkDeps;
  logger?: Pick<Console, "warn">;
  delay?: (ms: number) => Promise<void>;
};

export class LinkPreviewBusyError extends Error {
  constructor() {
    super("Too many link previews are already being fetched.");
    this.name = "LinkPreviewBusyError";
  }
}

export type LinkPreviewResult = {
  id: string;
  status: "READY" | "NEGATIVE";
  failureCode: string | null;
  requestedUrl: string;
  resolvedUrl: string | null;
  title: string | null;
  description: string | null;
  imageBlobId: string | null;
  faviconBlobId: string | null;
};

function canonicalUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewFetchError("INVALID_URL", "A valid absolute URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new PreviewFetchError(
      "INVALID_URL",
      "Only HTTP and HTTPS URLs without credentials are supported.",
    );
  }
  url.hash = "";
  return url;
}

const cacheKeyFor = (userId: string, url: URL): string =>
  createHash("sha256").update(userId).update("\0").update(url.href).digest("hex");

function networkLimits(config: LinkPreviewConfig, kind: "page" | "image"): PreviewNetworkLimits {
  return {
    dnsTimeoutMs: config.dnsTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    maxRedirects: config.maxRedirects,
    allowedPorts: config.allowedPorts,
    dnsConcurrency: config.dnsConcurrency,
    dnsQueueSize: config.dnsQueueSize,
    maxWireBytes: kind === "page" ? config.maxPageWireBytes : config.maxImageWireBytes,
    maxDecodedBytes: kind === "page" ? config.maxPageDecodedBytes : config.maxImageDecodedBytes,
  };
}

function imageLimits(config: LinkPreviewConfig, favicon: boolean): ImageLimits {
  return {
    maxPixels: config.maxImagePixels,
    maxDimension: favicon ? config.maxFaviconDimension : config.maxImageDimension,
    maxOutputBytes: config.maxSanitizedImageBytes,
    timeoutMs: config.imageProcessTimeoutMs,
  };
}

function publicResult(row: any): LinkPreviewResult {
  return {
    id: row.id,
    status: row.status,
    failureCode: row.failureCode ?? null,
    requestedUrl: row.requestedUrl,
    resolvedUrl: row.resolvedUrl ?? null,
    title: row.title ?? null,
    description: row.description ?? null,
    imageBlobId: row.imageBlobId ?? null,
    faviconBlobId: row.faviconBlobId ?? null,
  };
}

async function storeSanitizedImage(deps: ServiceDeps, bytes: Buffer) {
  if (bytes.length > deps.config.cacheBudgetBytes) {
    throw new Error("The sanitized image is larger than the preview cache budget.");
  }
  await evictLinkPreviewCache(deps);
  const free = await freeDiskPercent(deps.storageDir);
  if (free !== null && free < deps.config.minFreeDiskPercent) {
    await evictLinkPreviewCache(deps, undefined, true);
    const after = await freeDiskPercent(deps.storageDir);
    if (after !== null && after < deps.config.minFreeDiskPercent) {
      throw new Error("The preview cache cannot preserve the configured disk reserve.");
    }
  }
  let used = await previewDiskBytes(deps.prisma);
  if (used + bytes.length > deps.config.cacheBudgetBytes) {
    await evictLinkPreviewCache(deps, undefined, true);
    used = await previewDiskBytes(deps.prisma);
    if (used + bytes.length > deps.config.cacheBudgetBytes) {
      throw new Error("The preview cache byte budget is exhausted.");
    }
  }
  const { blob } = await storeBlob(
    { prisma: deps.prisma, storageDir: deps.storageDir },
    {
      source: Readable.from([bytes]),
      limitBytes: deps.config.maxSanitizedImageBytes,
      purpose: "LINK_PREVIEW",
    },
  );
  return blob;
}

async function mirrorImage(
  deps: ServiceDeps,
  url: URL | null,
  favicon: boolean,
): Promise<any | null> {
  if (!url) return null;
  try {
    const fetched = deps.fetchResource
      ? await deps.fetchResource(url, "image", networkLimits(deps.config, "image"))
      : await fetchPreviewResource(
          url,
          "image",
          networkLimits(deps.config, "image"),
          deps.networkDeps,
        );
    const clean = await (deps.sanitizeImage ?? sanitizePreviewImage)(
      fetched.body,
      imageLimits(deps.config, favicon),
    );
    return await storeSanitizedImage(deps, clean);
  } catch {
    // A card without art is preferable to disclosing the foreign URL or
    // serving bytes that did not survive every image check.
    return null;
  }
}

async function cacheFailure(
  deps: ServiceDeps,
  key: string,
  url: URL,
  code: string,
  userId: string,
) {
  const now = deps.now?.() ?? Date.now();
  const values = {
    requestedUrl: url.href,
    resolvedUrl: null,
    status: "NEGATIVE",
    failureCode: code,
    title: null,
    description: null,
    imageBlobId: null,
    faviconBlobId: null,
    ownerUserId: userId,
    lastAccessedAt: new Date(now),
    expiresAt: new Date(now + deps.config.negativeTtlMs),
  };
  return replaceCachedRow(
    deps,
    key,
    {
      cacheKey: key,
      ...values,
    },
    values,
  );
}

async function buildPreview(deps: ServiceDeps, key: string, url: URL, userId: string) {
  const startedAt = Date.now();
  try {
    const page = deps.fetchResource
      ? await deps.fetchResource(url, "html", networkLimits(deps.config, "page"))
      : await fetchPreviewResource(
          url,
          "html",
          networkLimits(deps.config, "page"),
          deps.networkDeps,
        );
    const metadata = extractLinkMetadata(page.body, page.finalUrl);
    const image = await mirrorImage(deps, metadata.imageUrl, false);
    const favicon = await mirrorImage(deps, metadata.faviconUrl, true);
    if (!metadata.title && !metadata.description && !image && !favicon) {
      return cacheFailure(deps, key, url, "NO_METADATA", userId);
    }
    const now = deps.now?.() ?? Date.now();
    const values = {
      requestedUrl: url.href,
      resolvedUrl: page.finalUrl.href,
      status: "READY",
      failureCode: null,
      title: metadata.title,
      description: metadata.description,
      imageBlobId: image?.id ?? null,
      faviconBlobId: favicon?.id ?? null,
      ownerUserId: userId,
      lastAccessedAt: new Date(now),
      expiresAt: new Date(now + deps.config.positiveTtlMs),
    };
    return await replaceCachedRow(
      deps,
      key,
      {
        cacheKey: key,
        ...values,
      },
      values,
    );
  } catch (error) {
    const internalCode = error instanceof PreviewFetchError ? error.code : "FETCH_FAILED";
    // The failure class is enough to operate the service. Target names,
    // addresses, response bytes and exception text may contain user data or
    // credentials and deliberately never enter logs.
    (deps.logger ?? console).warn(`[link-preview] fetch failed with ${internalCode}`);
    // A private DNS answer, NXDOMAIN and a refused public connection must not
    // become a hostname/port oracle. They share one public code and one minimum
    // response time; only the non-sensitive failure class remains in the
    // server log above.
    //
    // The floor is deliberately shorter than the total timeout. Every one of
    // those answers arrives within milliseconds, so a floor well above them
    // makes them indistinguishable from each other, which is the oracle worth
    // closing. Holding each failure for the full timeout instead would let four
    // bad links occupy every worker for eight seconds and leave nobody able to
    // fetch a preview at all.
    const remaining = FAILURE_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) {
      await (deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(remaining);
    }
    return cacheFailure(deps, key, url, "UNAVAILABLE", userId);
  }
}

export function createLinkPreviewService(deps: ServiceDeps) {
  const queue = new BoundedTaskQueue();
  const activeByUser = new Map<string, number>();
  const inFlight = new Map<string, Promise<LinkPreviewResult>>();

  return async (userId: string, rawUrl: string): Promise<LinkPreviewResult> => {
    const url = canonicalUrl(rawUrl);
    const key = cacheKeyFor(userId, url);
    const cached = await freshCached(deps, key);
    if (cached) return publicResult(cached);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const active = activeByUser.get(userId) ?? 0;
    if (active >= deps.config.maxConcurrentPerUser) throw new LinkPreviewBusyError();
    activeByUser.set(userId, active + 1);
    const work = queue
      .run(
        {
          concurrency: deps.config.maxConcurrentInstance,
          maxWaiting: deps.config.maxQueueSize,
        },
        async () =>
          publicResult(
            (await freshCached(deps, key)) ?? (await buildPreview(deps, key, url, userId)),
          ),
      )
      .then(async (result) => {
        await evictLinkPreviewCache(deps, userId);
        return result;
      })
      .finally(() => {
        const remaining = (activeByUser.get(userId) ?? 1) - 1;
        if (remaining > 0) activeByUser.set(userId, remaining);
        else activeByUser.delete(userId);
        inFlight.delete(key);
      });
    inFlight.set(key, work);
    return work;
  };
}
