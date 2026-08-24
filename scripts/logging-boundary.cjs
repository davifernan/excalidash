#!/usr/bin/env node
/**
 * Enforces one backend logging channel (NIL-411/NIL-502), the same shape as
 * adapter-boundary.cjs and authz-boundary.cjs: a small allow-list plus a
 * named-exception baseline that shrinks as consumers migrate, never a
 * wildcard.
 *
 * Before this check, "the backend error path loses its thread" and "the
 * production log is noise" were two symptoms of the same root cause: 246
 * scattered call sites (measured 24.08: 63 frontend console.error, 91
 * backend console.error, 92 backend console.log), each deciding its own
 * level, shape, and correlation fields, or deciding none at all. A tracker,
 * a log aggregator, or a human reading `docker logs` cannot rely on a shape
 * that 91 different call sites each invented separately.
 *
 * `backend/src/logger.ts` is now the only legal place. This check only
 * covers `backend/src` -- the frontend's 63 console.error sites are a
 * different mechanism (see the NIL-415 diagnostics-sink discussion) and are
 * explicitly out of scope for this pass.
 *
 * STRUCTURAL_EXCEPTIONS are permanent, not baseline: `config.ts` cannot
 * import `logger.ts` (the logger reads `config.logLevel`; the reverse edge
 * would be a cycle), so config's own validation output during startup has
 * nowhere else to go. `securityTest.ts` is a standalone manual diagnostic
 * script, not server code -- it is never imported by `index.ts` or any
 * route, and its console.log calls ARE its output, not a log line about
 * something else.
 *
 * BASELINE was the measured starting state at NIL-502 -- 42 files / 134 call
 * sites that still called console.* directly -- and NIL-504 paid all of it
 * down to zero: every one of those 42 files now logs through `logger.*`
 * (each removal proved itself by turning that file's baseline entry STALE
 * first, per the check below -- a progress indicator that cannot lie). The
 * set stays declared, empty, rather than deleted: a future violation must
 * still be added by name, and the empty set is the record that this baseline
 * was paid down instead of quietly forgotten, which is the NIL-489 lesson
 * this whole effort exists to not repeat.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "backend", "src");
const LOGGER_FILE = path.join("backend", "src", "logger.ts");

const CONSOLE_CALL = /console\.(error|warn|log|info|debug)\s*\(/;

/**
 * Permanent, not migration debt. See the file header for why each one
 * cannot go through logger.ts at all.
 */
const STRUCTURAL_EXCEPTIONS = new Set([
  "backend/src/config.ts",
  "backend/src/securityTest.ts",
]);

/**
 * Temporary. Every entry here is a file that has not been migrated to
 * `logger.*` yet -- remove it from this list in the same change that
 * migrates it. A stale entry (migrated but still listed) is caught below,
 * same as adapter-boundary.cjs's stale-exception handling.
 *
 * Empty as of NIL-504: the 42-file/134-call-site baseline measured at
 * NIL-502 is fully paid down. Stays declared (not deleted) so the next
 * violation is a visible addition, not a silent reappearance.
 */
const BASELINE = new Set([]);

const isTestFile = (relative) =>
  /\.test\.tsx?$/.test(relative) ||
  /\.integration\.tsx?$/.test(relative) ||
  relative.includes("/__tests__/");

const isGenerated = (relative) => relative.startsWith("backend/src/generated/");

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
    console.error(`No backend source at ${SRC}`);
    process.exit(2);
  }

  const files = walk(SRC).filter((file) => {
    const relative = rel(file);
    return !isTestFile(relative) && !isGenerated(relative) && relative !== LOGGER_FILE;
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
      `${relative}: calls console.* directly. Use backend/src/logger.ts (logger.error/warn/info/debug) instead.`,
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
      `Logging boundary holds. ${files.length} backend files checked, ` +
        `${STRUCTURAL_EXCEPTIONS.size} structural exceptions, ${BASELINE.size} baseline files remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of stale) console.error(`STALE      ${line}`);
  process.exit(1);
};

module.exports = { STRUCTURAL_EXCEPTIONS, BASELINE, walk, rel, SRC, LOGGER_FILE, CONSOLE_CALL };

if (require.main === module) {
  main();
}
