import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { type TcpNetConnectOpts } from "node:net";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { PreviewFetchError, resolvePublicAddresses, type ResolvedAddress } from "./resolver";

export { isPublicAddress } from "./addressPolicy";
export { PreviewFetchError, resolvePublicAddresses } from "./resolver";
export type { ResolvedAddress } from "./resolver";

export type PreviewFetchKind = "html" | "image";

export type PreviewNetworkLimits = {
  dnsTimeoutMs: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
  allowedPorts: number[];
  dnsConcurrency: number;
  dnsQueueSize: number;
  maxWireBytes: number;
  maxDecodedBytes: number;
};

export type PreviewFetchResult = {
  body: Buffer;
  contentType: string;
  finalUrl: URL;
  headers: IncomingHttpHeaders;
};

/** Longest marker searched for, so a split across chunk boundaries is still seen. */
const MARKER_OVERLAP = 10;

export type PreviewNetworkDeps = {
  /** Supplies DNS answers only. Address policy is deliberately not injectable. */
  lookup?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
  request?: (
    url: URL,
    address: ResolvedAddress,
    connectTimeoutMs: number,
    signal: AbortSignal,
  ) => Promise<IncomingMessage>;
  /** Test seam below HTTP: production always opens the checked IP itself. */
  connect?: (options: TcpNetConnectOpts) => Duplex;
};

const timeoutError = (part: string) =>
  new PreviewFetchError("TIMEOUT", `The remote ${part} did not finish in time.`);

/**
 * The request options that pin a fetch to an address that has been checked.
 *
 * Everything here except how the socket is made is the same whether or not a
 * connect override is supplied — deliberately, because the test suite can only
 * observe the override branch while production always takes the other one. It
 * lives in its own function so both can be read and compared directly.
 *
 * `hostname` is the checked address, never the name: that is what stops a
 * second DNS answer from redirecting the connection somewhere else. `Host` and
 * `servername` keep the original name so virtual hosts and TLS still work.
 *
 * `agent: false` builds a throwaway Agent, and an Agent connects for itself,
 * which means it silently ignores createConnection. Without an override that
 * is what we want, since it pools nothing; with one, the override has to be
 * what actually dials.
 */
export function pinnedRequestOptions(
  url: URL,
  target: ResolvedAddress,
  connect?: (options: TcpNetConnectOpts) => Duplex,
) {
  return {
    protocol: url.protocol,
    hostname: target.address,
    family: target.family,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET" as const,
    // Pin this explicitly instead of inheriting a Node-major-dependent default.
    maxHeaderSize: 16 * 1024,
    ...(connect ? { createConnection: connect } : { agent: false as const }),
    servername: url.hostname.replace(/^\[|\]$/g, ""),
    headers: {
      Host: url.host,
      Accept: "text/html, image/avif, image/webp, image/png, image/jpeg;q=0.9, */*;q=0.1",
      "Accept-Encoding": "br, gzip, deflate",
      "User-Agent": "ExcaliDash-LinkPreview/1.0",
    },
  };
}

function openPinnedRequest(
  url: URL,
  target: ResolvedAddress,
  connectTimeoutMs: number,
  signal: AbortSignal,
  connect?: (options: TcpNetConnectOpts) => Duplex,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({ ...pinnedRequestOptions(url, target, connect), signal });
    const connectTimer = setTimeout(
      () => request.destroy(timeoutError("connection")),
      connectTimeoutMs,
    );
    request.once("socket", (socket) => {
      const connected = () => clearTimeout(connectTimer);
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", connected);
    });
    request.once("response", (response) => {
      clearTimeout(connectTimer);
      resolve(response);
    });
    request.once("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    request.end();
  });
}

function checkedUrl(raw: string | URL, previous?: URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  } catch {
    throw new PreviewFetchError("INVALID_URL", "A valid absolute URL is required.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreviewFetchError("INVALID_URL", "Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new PreviewFetchError("INVALID_URL", "URLs containing credentials are not supported.");
  }
  if (previous?.protocol === "https:" && url.protocol !== "https:") {
    throw new PreviewFetchError("HTTPS_DOWNGRADE", "HTTPS redirects may not downgrade to HTTP.");
  }
  url.hash = "";
  return url;
}

function checkedPort(url: URL, allowedPorts: number[]): void {
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new PreviewFetchError("PORT_BLOCKED", `Port ${port} is not allowed for link previews.`);
  }
}

function contentTypeOf(headers: IncomingHttpHeaders): string {
  return String(headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function decodedStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "identity")
    .toLowerCase()
    .trim();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  throw new PreviewFetchError("UNSUPPORTED_ENCODING", "The response uses an unsupported encoding.");
}

async function readBounded(
  response: IncomingMessage,
  limits: PreviewNetworkLimits,
  stopAfterHead: boolean,
): Promise<Buffer> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limits.maxWireBytes) {
    response.destroy();
    throw new PreviewFetchError("TOO_LARGE", "The response is larger than the allowed limit.");
  }
  let wireBytes = 0;
  response.on("data", (chunk: Buffer) => {
    wireBytes += chunk.length;
    if (wireBytes > limits.maxWireBytes) response.destroy();
  });
  let stream: Readable;
  try {
    stream = decodedStream(response);
  } catch (error) {
    response.destroy();
    throw error;
  }
  const chunks: Buffer[] = [];
  let scanned = "";
  const bodyPattern = /<(?:body|frameset)\b/g;
  let decodedBytes = 0;
  try {
    for await (const value of stream) {
      if (wireBytes > limits.maxWireBytes) {
        throw new PreviewFetchError("TOO_LARGE", "The compressed response exceeded its limit.");
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      decodedBytes += chunk.length;
      if (decodedBytes > limits.maxDecodedBytes) {
        throw new PreviewFetchError("TOO_LARGE", "The decoded response exceeded its limit.");
      }
      chunks.push(chunk);
      if (stopAfterHead) {
        // Only the newly arrived text is decoded and searched. Rebuilding the
        // whole buffer per chunk made the work quadratic in the number of
        // chunks: a server that dribbles out half a megabyte one byte at a time
        // would have this copying gigabytes. latin1 is one byte per character,
        // so appending chunk by chunk is exact regardless of where they split.
        const seenBefore = scanned.length;
        scanned += chunk.toString("latin1").toLowerCase();
        // Back up far enough that a marker split across two chunks is still found.
        const from = Math.max(0, seenBefore - MARKER_OVERLAP);
        const headEnd = scanned.indexOf("</head", from);
        bodyPattern.lastIndex = from;
        const bodyStart = bodyPattern.exec(scanned)?.index ?? -1;
        if (headEnd >= 0 || bodyStart >= 0) {
          const body = Buffer.concat(chunks);
          if (bodyStart >= 0 && (headEnd < 0 || bodyStart < headEnd)) {
            return body.subarray(0, bodyStart);
          }
          const close = body.indexOf(0x3e, headEnd);
          return close >= 0 ? body.subarray(0, close + 1) : body;
        }
      }
    }
  } catch (error) {
    if (wireBytes > limits.maxWireBytes) {
      throw new PreviewFetchError("TOO_LARGE", "The compressed response exceeded its limit.");
    }
    throw error;
  } finally {
    response.destroy();
    if (stream !== response) stream.destroy();
  }
  return Buffer.concat(chunks);
}

export async function fetchPreviewResource(
  rawUrl: string | URL,
  kind: PreviewFetchKind,
  limits: PreviewNetworkLimits,
  deps: PreviewNetworkDeps = {},
  outerSignal?: AbortSignal,
): Promise<PreviewFetchResult> {
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(timeoutError("request")),
    limits.totalTimeoutMs,
  );
  const abort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", abort, { once: true });
  let current = checkedUrl(rawUrl);
  try {
    for (let redirects = 0; ; redirects += 1) {
      checkedPort(current, limits.allowedPorts);
      const addresses = await resolvePublicAddresses(
        current.hostname,
        limits.dnsTimeoutMs,
        controller.signal,
        {
          lookup: deps.lookup,
          concurrency: limits.dnsConcurrency,
          maxWaiting: limits.dnsQueueSize,
        },
      );
      const response = deps.request
        ? await deps.request(current, addresses[0], limits.connectTimeoutMs, controller.signal)
        : await openPinnedRequest(
            current,
            addresses[0],
            limits.connectTimeoutMs,
            controller.signal,
            deps.connect,
          );
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.destroy();
        if (redirects >= limits.maxRedirects) {
          throw new PreviewFetchError("TOO_MANY_REDIRECTS", "The URL redirected too many times.");
        }
        const location = response.headers.location;
        if (!location)
          throw new PreviewFetchError("BAD_REDIRECT", "The redirect has no destination.");
        current = checkedUrl(new URL(location, current), current);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new PreviewFetchError("HTTP_STATUS", `The remote server returned HTTP ${status}.`);
      }
      const contentType = contentTypeOf(response.headers);
      if (kind === "html" ? contentType !== "text/html" : !contentType.startsWith("image/")) {
        response.destroy();
        throw new PreviewFetchError(
          "UNSUPPORTED_TYPE",
          "The response is not the expected content type.",
        );
      }
      const body = await readBounded(response, limits, kind === "html");
      return { body, contentType, finalUrl: current, headers: response.headers };
    }
  } catch (error) {
    if (error instanceof PreviewFetchError) throw error;
    if (controller.signal.aborted) throw timeoutError("request");
    throw new PreviewFetchError("NETWORK_ERROR", "The remote server could not be reached.");
  } finally {
    clearTimeout(totalTimer);
    outerSignal?.removeEventListener("abort", abort);
  }
}
