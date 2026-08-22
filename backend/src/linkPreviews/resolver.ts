import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { BoundedTaskQueue } from "../utils/boundedTaskQueue";
import { isPublicAddress } from "./addressPolicy";

export type ResolvedAddress = { address: string; family: 4 | 6 };

export class PreviewFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PreviewFetchError";
  }
}

const dnsQueue = new BoundedTaskQueue();

const timeoutError = (part: string) =>
  new PreviewFetchError("TIMEOUT", `The remote ${part} did not finish in time.`);

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  part: string,
  outerSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(timeoutError("request"));
  const timer = setTimeout(() => controller.abort(timeoutError(part)), timeoutMs);
  let rejectAborted!: (error: unknown) => void;
  const aborted = new Promise<T>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const rejectFromAbort = () => rejectAborted(controller.signal.reason ?? timeoutError(part));
  controller.signal.addEventListener("abort", rejectFromAbort, { once: true });
  if (outerSignal.aborted) abortFromRequest();
  else outerSignal.addEventListener("abort", abortFromRequest, { once: true });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", abortFromRequest);
    controller.signal.removeEventListener("abort", rejectFromAbort);
  }
}

const missingDnsAnswer = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
};

/** One resolver per job makes `cancel()` local to exactly one queue slot. */
async function cancellableDnsLookup(
  hostname: string,
  signal: AbortSignal,
): Promise<ResolvedAddress[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  if (signal.aborted) throw signal.reason;
  signal.addEventListener("abort", cancel, { once: true });
  const withoutMissingFamily = async <T>(work: Promise<T>): Promise<T | []> => {
    try {
      return await work;
    } catch (error) {
      if (missingDnsAnswer(error)) return [];
      throw error;
    }
  };
  try {
    const [ipv4, ipv6] = await Promise.all([
      withoutMissingFamily(resolver.resolve4(hostname)),
      withoutMissingFamily(resolver.resolve6(hostname)),
    ]);
    return [
      ...(ipv4 as string[]).map((address) => ({ address, family: 4 as const })),
      ...(ipv6 as string[]).map((address) => ({ address, family: 6 as const })),
    ];
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function resolvePublicAddresses(
  rawHostname: string,
  timeoutMs: number,
  signal: AbortSignal,
  options: {
    lookup?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
    concurrency?: number;
    maxWaiting?: number;
  } = {},
): Promise<ResolvedAddress[]> {
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const found = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await withTimeout(
        (lookupSignal) =>
          dnsQueue.run(
            {
              concurrency: options.concurrency ?? 8,
              maxWaiting: options.maxWaiting ?? 64,
              signal: lookupSignal,
            },
            () =>
              options.lookup
                ? options.lookup(hostname, lookupSignal)
                : cancellableDnsLookup(hostname, lookupSignal),
          ),
        timeoutMs,
        "name lookup",
        signal,
      );
  if (signal.aborted) throw timeoutError("request");
  if (found.length === 0) throw new PreviewFetchError("DNS_EMPTY", "The host has no address.");
  if (found.some(({ address }) => !isPublicAddress(address))) {
    throw new PreviewFetchError("SSRF_BLOCKED", "The address points to a non-public network.");
  }
  return found;
}
