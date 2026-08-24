/**
 * Making an uploaded PDF smaller.
 *
 * Generic compression does nothing here — a PDF already compresses its own
 * contents, and Brotli over real documents gained 0-9%. What does work is
 * rebuilding the document: Ghostscript re-encodes the embedded images at a
 * sensible resolution and drops what nothing references.
 *
 * Measured on real files:
 *
 *   coloring book   13.0 MB -> 4.1 MB   (-69%)   at "printer"
 *   photo book      76.4 MB -> 13.9 MB  (-82%)   at "printer"
 *   text-only spec   209 KB ->  256 KB  (+23%)   at "printer"
 *
 * That last line is the whole reason this is not applied blindly. Rebuilding a
 * text document makes it bigger, so the result is only kept when it is
 * actually smaller.
 *
 * This changes the file. Someone who uploads a document and downloads it again
 * gets a rebuilt one, not the bytes they sent. For a board full of reference
 * material that is a good trade; for anything where the exact file matters it
 * is not, which is why the threshold and the level are configurable and small
 * files are left alone entirely.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BoundedTaskQueue, QueueCapacityError } from "../utils/boundedTaskQueue";
import { config } from "../config";

const run = promisify(execFile);

/**
 * How hard to squeeze.
 *
 * "printer" keeps images at 300 dpi — at normal viewing size the result is not
 * distinguishable from the original, which is why it is the default. "ebook"
 * halves that again and is visibly softer on photographs.
 */
export type ShrinkLevel = "printer" | "ebook" | "screen" | "off";

export type ShrinkResult = {
  /** Whether the rebuilt file replaced the original. */
  applied: boolean;
  originalBytes: number;
  finalBytes: number;
  reason: "smaller" | "not-smaller" | "too-small" | "disabled" | "failed";
};

export type ShrinkOptions = {
  level: ShrinkLevel;
  /** Files below this are left alone: the saving would not be worth the risk. */
  minBytes: number;
  timeoutMs?: number;
  concurrency?: number;
  maxWaiting?: number;
  /** Told when a rebuild could not be completed, so it is not silently lost. */
  onFailure?: (error: unknown) => void;
  /** Test seam for the Ghostscript child process. */
  runCommand?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<unknown>;
};

const shrinkQueue = new BoundedTaskQueue();

/** Whether it is worth even trying, without touching the file. */
export function shouldTryShrink(sizeBytes: number, options: ShrinkOptions): boolean {
  if (options.level === "off") return false;
  return sizeBytes >= options.minBytes;
}

/**
 * Rebuild the PDF in place, keeping the result only if it came out smaller.
 *
 * The rebuild goes to a temporary file and is moved over the original at the
 * very end, so a failure or a crash leaves the uploaded file exactly as it was.
 */
export async function shrinkPdf(path: string, options: ShrinkOptions): Promise<ShrinkResult> {
  const before = (await stat(path)).size;

  if (options.level === "off") {
    return { applied: false, originalBytes: before, finalBytes: before, reason: "disabled" };
  }
  if (before < options.minBytes) {
    return { applied: false, originalBytes: before, finalBytes: before, reason: "too-small" };
  }

  try {
    return await shrinkQueue.run(
      {
        concurrency: options.concurrency ?? config.assets.pdfShrinkConcurrency,
        maxWaiting: options.maxWaiting ?? config.assets.pdfShrinkQueueLimit,
      },
      () => rebuildPdf(path, before, options),
    );
  } catch (error) {
    if (error instanceof QueueCapacityError) {
      // Admission pressure should not make an otherwise valid upload unusable.
      return { applied: false, originalBytes: before, finalBytes: before, reason: "failed" };
    }
    throw error;
  }
}

async function rebuildPdf(
  path: string,
  before: number,
  options: ShrinkOptions,
): Promise<ShrinkResult> {
  // The rebuild is staged next to the file it will replace rather than in the
  // system temp directory. In every container deployment the asset storage is
  // a mounted volume and the temp directory is not, so renaming across them
  // fails with EXDEV — and because the catch below treats any failure as "this
  // document simply cannot be rebuilt", that turned the whole feature off in
  // production without a word. Nothing walks the originals tree looking for
  // strays, and the directory is removed either way.
  const dir = await mkdtemp(join(dirname(path), ".pdfshrink-"));
  const rebuilt = join(dir, "out.pdf");
  try {
    await (options.runCommand ?? run)(
      "gs",
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.7",
        `-dPDFSETTINGS=/${options.level}`,
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        // Ghostscript reads a file somebody else produced, so it gets no
        // opportunity to reach anywhere: no shell, no network, no writing
        // outside the directory it was given.
        "-dSAFER",
        `-sOutputFile=${rebuilt}`,
        path,
      ],
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 1024 * 64 },
    );

    const after = (await stat(rebuilt)).size;
    if (after <= 0 || after >= before) {
      return { applied: false, originalBytes: before, finalBytes: before, reason: "not-smaller" };
    }

    await rename(rebuilt, path);
    return { applied: true, originalBytes: before, finalBytes: after, reason: "smaller" };
  } catch (error) {
    // A document Ghostscript cannot rebuild is still a perfectly good document,
    // so this is not an error for the person uploading. It is worth one line in
    // the log all the same: silence here once hid a broken deployment.
    options.onFailure?.(error);
    return { applied: false, originalBytes: before, finalBytes: before, reason: "failed" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How much a shrink saved, phrased for a person. */
export function describeShrink(result: ShrinkResult): string | null {
  if (!result.applied) return null;
  const percent = Math.round((1 - result.finalBytes / result.originalBytes) * 100);
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return `Optimised from ${mb(result.originalBytes)} MB to ${mb(result.finalBytes)} MB (${percent}% smaller).`;
}
