import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TestRunner } from "vitest";
import type { VitestRunnerImportSource } from "@vitest/runner";

const backendRoot = path.resolve(__dirname, "../..");
const packageJsonPath = path.join(backendRoot, "src", "generated", "client", "package.json");
const diagnosticDirectory = process.env.NIL703_PRISMA_DIAGNOSTIC_DIR;
const generationMarkerPath = process.env.NIL703_PRISMA_GENERATE_MARKER;

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
  try {
    const raw = fs.readFileSync(packageJsonPath);
    return {
      path: packageJsonPath,
      bytes: raw.byteLength,
      sha256: createHash("sha256").update(raw).digest("hex"),
      utf8: raw.toString("utf8"),
    };
  } catch (error) {
    return { path: packageJsonPath, readError: errorDetails(error) };
  }
};

const readGenerationMarker = () => {
  if (!generationMarkerPath) return { status: "not configured" };
  try {
    return {
      path: generationMarkerPath,
      value: JSON.parse(fs.readFileSync(generationMarkerPath, "utf8")),
    };
  } catch (error) {
    return { path: generationMarkerPath, readError: errorDetails(error) };
  }
};

const writeDiagnostic = (error: unknown, filepath: string, source: VitestRunnerImportSource) => {
  if (!diagnosticDirectory) return;

  try {
    const timestamp = new Date().toISOString();
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
      failingImport: { filepath, source },
      error: errorDetails(error),
      packageJson: readPackageJsonSnapshot(),
      prismaGenerateFinished: readGenerationMarker(),
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
    try {
      return await super.importFile(filepath, source);
    } catch (error) {
      if (isGeneratedClientPackageConfigError(error)) writeDiagnostic(error, filepath, source);
      throw error;
    }
  }
}
