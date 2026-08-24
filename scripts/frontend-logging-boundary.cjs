#!/usr/bin/env node
/**
 * Enforces one frontend logging channel (NIL-510/NIL-513), the same shape as
 * scripts/logging-boundary.cjs (backend) and scripts/env-boundary.cjs: an
 * allow-listed file plus named-exception sets that shrink to nothing, never
 * a wildcard.
 *
 * This is the mirror of NIL-504, with one difference that changes what the
 * check protects: a backend log line reaches a file or an aggregator
 * someone reads later; a frontend log line happens inside one person's
 * browser tab and, via a bare `console.error`, reaches nobody unless that
 * exact person has devtools open at that exact moment. `frontend/src/
 * logging.ts` is the only legal place to write one -- every call site that
 * wants to log calls `log.error/warn/info/debug` instead of `console.*`
 * directly, and `log.error` gives its failure an actual reader by default
 * (see that file's own header) instead of just being a structurally
 * centralized, unread pass-through -- the gap
 * docs/architecture/ERROR_TRACKER_DECISION.md named in `onDiagnostic` and
 * `AppErrorBoundary.componentDidCatch` before this pass closed it for both.
 *
 * Measured 24.08 (NIL-510): 64 raw console.error call sites, 114 catch
 * blocks, in frontend/src, none behind a structural channel.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "frontend", "src");
const LOGGING_FILE = path.join("frontend", "src", "logging.ts");

const CONSOLE_CALL = /console\.(error|warn|log|info|debug)\s*\(/;

/**
 * Permanent, not migration debt. `logging.ts` itself is excluded by path
 * (it IS the channel; see LOGGING_FILE below), so this set covers files
 * with a structural reason nothing else on this list has.
 *
 * `AppErrorBoundary.tsx` catches `console.error` itself, indirectly, in a
 * different sense: React logs every caught render error to the console on
 * its own before `componentDidCatch` ever runs, and that browser/React
 * behavior is not a call site this repo owns or can route through
 * `logging.ts`. `componentDidCatch`'s *own* `console.error` call is not
 * exempt -- it is migrated to `log.error(..., { notify: false })`, since the
 * boundary's fallback UI (not a toast) is already this failure's reader; see
 * that file's comment for why a toast would not render at that moment
 * anyway (the Toaster instance lives inside the tree the boundary just
 * replaced).
 */
const STRUCTURAL_EXCEPTIONS = new Set([]);

/**
 * Temporary. Every entry here is a file that has not been migrated to
 * `log.*` yet -- remove it from this list in the same change that migrates
 * it. A stale entry (migrated but still listed) is caught below, same as
 * logging-boundary.cjs's stale-exception handling.
 */
const BASELINE = new Set([]);

const isTestFile = (relative) =>
  /\.test\.tsx?$/.test(relative) ||
  /\.integration\.tsx?$/.test(relative) ||
  relative.includes("/__tests__/") ||
  relative.includes("/test/");

const isGenerated = (relative) => relative.startsWith("frontend/src/generated/");

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

const main = () => {
  if (!fs.existsSync(SRC)) {
    console.error(`No frontend source at ${SRC}`);
    process.exit(2);
  }

  const files = walk(SRC).filter((file) => {
    const relative = rel(file);
    return !isTestFile(relative) && !isGenerated(relative) && relative !== LOGGING_FILE;
  });

  const violations = [];
  const usedStructural = new Set();
  const usedBaseline = new Set();

  for (const file of files) {
    const relative = rel(file);
    const contents = fs.readFileSync(file, "utf8");
    if (!CONSOLE_CALL.test(contents)) continue;

    if (STRUCTURAL_EXCEPTIONS.has(relative)) {
      usedStructural.add(relative);
      continue;
    }
    if (BASELINE.has(relative)) {
      usedBaseline.add(relative);
      continue;
    }
    violations.push(
      `${relative}: calls console.* directly. Use frontend/src/logging.ts (log.error/warn/info/debug) instead.`,
    );
  }

  const stale = [];
  for (const entry of STRUCTURAL_EXCEPTIONS) {
    if (!usedStructural.has(entry)) {
      stale.push(`${entry}: listed as a structural exception but no longer calls console.* -- remove it.`);
    }
  }
  for (const entry of BASELINE) {
    if (!usedBaseline.has(entry)) {
      stale.push(`${entry}: listed in the baseline but no longer calls console.* -- remove it, the migration moved this one already.`);
    }
  }

  if (violations.length === 0 && stale.length === 0) {
    console.log(
      `Frontend logging boundary holds. ${files.length} frontend files checked, ` +
        `${STRUCTURAL_EXCEPTIONS.size} structural exceptions, ${BASELINE.size} baseline files remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of stale) console.error(`STALE      ${line}`);
  process.exit(1);
};

module.exports = { STRUCTURAL_EXCEPTIONS, BASELINE, walk, rel, SRC, LOGGING_FILE, CONSOLE_CALL };

if (require.main === module) {
  main();
}
