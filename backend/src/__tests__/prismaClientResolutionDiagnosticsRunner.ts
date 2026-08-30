import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TestRunner } from "vitest";
import type { VitestRunnerImportSource } from "@vitest/runner";

const backendRoot = path.resolve(__dirname, "../..");
const packageJsonPath = path.join(backendRoot, "src", "generated", "client", "package.json");
const diagnosticDirectory = process.env.NIL703_PRISMA_DIAGNOSTIC_DIR;
const generationMarkerPath = process.env.NIL703_PRISMA_GENERATE_MARKER;
const integrityMarkerPath = process.env.NIL703_PRISMA_INTEGRITY_MARKER;
let suiteImportAttempt = 0;

const errorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as NodeJS.ErrnoException).code,
      path: (error as NodeJS.ErrnoException).path,
    };
  }
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : "non-Error throw",
      message: typeof value.message === "string" ? value.message : JSON.stringify(value),
      code: typeof value.code === "string" ? value.code : undefined,
      path: typeof value.path === "string" ? value.path : undefined,
    };
  }
  return { name: "non-Error throw", message: String(error) };
};

const isGeneratedClientPackageConfigError = (error: unknown) => {
  const details = errorDetails(error);
  return (
    (details.path === packageJsonPath || details.message.includes(packageJsonPath)) &&
    (details.name === "JSONError" ||
      details.message.includes("JSONError") ||
      details.message.includes("package config") ||
      details.code === "ERR_INVALID_PACKAGE_CONFIG")
  );
};

const readPackageJsonSnapshot = () => {
  const capturedAt = new Date().toISOString();
  const capturedAtHrtimeNs = process.hrtime.bigint().toString();
  try {
    const raw = fs.readFileSync(packageJsonPath);
    return {
      capturedAt,
      capturedAtHrtimeNs,
      path: packageJsonPath,
      bytes: raw.byteLength,
      sha256: createHash("sha256").update(raw).digest("hex"),
      utf8: raw.toString("utf8"),
    };
  } catch (error) {
    return {
      capturedAt,
      capturedAtHrtimeNs,
      path: packageJsonPath,
      readError: errorDetails(error),
    };
  }
};

const readTimestampMarker = (markerPath: string | undefined, capturedAtMs: number) => {
  if (!markerPath) return { status: "not configured" };
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      finishedAt?: unknown;
    };
    const finishedAtMs =
      typeof value.finishedAt === "string" ? Date.parse(value.finishedAt) : Number.NaN;
    return {
      path: markerPath,
      value,
      elapsedMsAtFailure: Number.isFinite(finishedAtMs) ? capturedAtMs - finishedAtMs : null,
    };
  } catch (error) {
    return { path: markerPath, readError: errorDetails(error) };
  }
};

const writeDiagnostic = (
  error: unknown,
  filepath: string,
  source: VitestRunnerImportSource,
  importAttempt: number,
  packageJsonBeforeImport: ReturnType<typeof readPackageJsonSnapshot>,
) => {
  if (!diagnosticDirectory) return;

  try {
    const timestamp = new Date().toISOString();
    const timestampMs = Date.now();
    const workerId = process.env.VITEST_WORKER_ID ?? "unknown";
    const diagnostic = {
      schema: "nil-703-prisma-client-resolution-diagnostic/v1",
      capturedAt: timestamp,
      capturedAtHrtimeNs: process.hrtime.bigint().toString(),
      failingProcess: {
        pid: process.pid,
        workerId,
        poolId: process.env.VITEST_POOL_ID ?? "unknown",
      },
      failingImport: { filepath, source, suiteImportAttempt: importAttempt },
      error: errorDetails(error),
      // The before/after pair brackets the import that failed. A changed pair
      // is evidence of a transient write; an unchanged pair does not prove a
      // cache cause, but rules out a persistent on-disk difference at either
      // observation point.
      packageJson: {
        beforeImport: packageJsonBeforeImport,
        afterImport: readPackageJsonSnapshot(),
      },
      // The integrity marker is the primary reference: it proves this exact
      // file parsed after generation and before Vitest began importing suites.
      // Keep the generation marker too, so a future failure still shows both
      // intervals without assuming which one caused it.
      prismaClientIntegrityVerified: readTimestampMarker(integrityMarkerPath, timestampMs),
      prismaGenerateFinished: readTimestampMarker(generationMarkerPath, timestampMs),
    };
    fs.mkdirSync(diagnosticDirectory, { recursive: true });
    const outputPath = path.join(
      diagnosticDirectory,
      `prisma-client-resolution-${process.pid}-${workerId}-${Date.now()}.json`,
    );
    fs.writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
    console.error(`NIL-703 diagnostic captured in the failing Vitest fork: ${outputPath}`);
  } catch (diagnosticError) {
    // The original module-resolution error is more valuable than a failed
    // diagnostic write. Never replace it or emit noise on healthy runs.
    console.error(`NIL-703 diagnostic capture failed: ${errorDetails(diagnosticError).message}`);
  }
};

export default class PrismaClientResolutionDiagnosticsRunner extends TestRunner {
  override async importFile(filepath: string, source: VitestRunnerImportSource) {
    // Vitest collects one suite at a time in this repository's single fork.
    // This is deliberately a suite-import ordinal, not a claim about how many
    // internal Node resolutions the Vite module runner performed.
    const importAttempt = source === "collect" ? ++suiteImportAttempt : suiteImportAttempt;
    // Retain a small in-memory snapshot only. It produces neither an artifact
    // nor output in green runs, but lets a failing import be compared with the
    // file that existed immediately before that import began.
    const packageJsonBeforeImport = readPackageJsonSnapshot();
    try {
      return await super.importFile(filepath, source);
    } catch (error) {
      if (isGeneratedClientPackageConfigError(error)) {
        writeDiagnostic(error, filepath, source, importAttempt, packageJsonBeforeImport);
      }
      throw error;
    }
  }
}
