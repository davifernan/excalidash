#!/usr/bin/env node
/**
 * Enforces one place that reads `process.env` in the backend (NIL-505), the
 * same shape as logging-boundary.cjs, authz-boundary.cjs, and
 * adapter-boundary.cjs: an allow-listed directory plus named-exception sets
 * that are supposed to be empty, never a wildcard.
 *
 * Upstream (origin/alpha, Zimeng's 0.6.0) ships `scripts/check-env-boundary.cjs`
 * for the same rule. This is a from-scratch reimplementation matching this
 * repo's boundary-check conventions (named exceptions, a counterprobe proving
 * both directions, a sandboxed red rehearsal) rather than a port of the
 * upstream file.
 *
 * Why this matters here specifically: `backend/src/config.ts` is the only
 * place that validates an environment variable, applies its default, and
 * throws a clear error at startup if it is malformed. A second `process.env`
 * read anywhere else re-implements that parsing ad hoc -- with its own
 * default, its own validation (often none), and no relationship to what
 * `config.ts` already computed for the same variable. NIL-505's own
 * measurement (24.08) found `backend/src/db/prisma.ts` and
 * `backend/src/assets/pageCache.ts` doing exactly this for `DATABASE_URL` and
 * `ASSET_RENDER_CONCURRENCY`: config.ts had already resolved both, and the
 * second read was pure duplication that could silently drift if the two
 * copies were ever edited differently.
 *
 * Logging (scripts/logging-boundary.cjs's own file header) is the standing
 * proof of what happens when this kind of centralization ships without a
 * guard: a single legal channel existed, nothing enforced it, and the repo
 * measured 246 scattered call sites before NIL-502/NIL-504 paid it back down.
 * This check exists so the env-reading boundary does not repeat that.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "backend", "src");
const ALLOWED_FILE = path.join("backend", "src", "config.ts");
const ALLOWED_DIR_PREFIX = "backend/src/config/";

const ENV_ACCESS = /process\s*\.\s*env\b/;

/**
 * Permanent, not migration debt. Empty: nothing in this repo has a
 * structural reason to read `process.env` outside `config.ts`/`config/` --
 * every case measured at NIL-505 (17 files, ~35 call sites) had a clean path
 * into a `config.*` field and was migrated in the same change that added
 * this check. A future entry here needs a concrete reason a config field
 * cannot express (dotenv.config() itself, or genuinely dynamic key lookup
 * that config's typed shape cannot represent), not convenience.
 */
const STRUCTURAL_EXCEPTIONS = new Set([]);

/**
 * Temporary, like logging-boundary.cjs's BASELINE. Empty as of NIL-505: the
 * 17-file measured starting state is fully migrated. Stays declared so a
 * future violation is a visible addition, not a silent reappearance.
 */
const BASELINE = new Set([]);

const isTestFile = (relative) =>
  /\.test\.tsx?$/.test(relative) ||
  /\.integration\.tsx?$/.test(relative) ||
  relative.includes("/__tests__/");

const isGenerated = (relative) => relative.startsWith("backend/src/generated/");

const isAllowed = (relative) => relative === ALLOWED_FILE || relative.startsWith(ALLOWED_DIR_PREFIX);

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
    return !isTestFile(relative) && !isGenerated(relative) && !isAllowed(relative);
  });

  const violations = [];
  const usedStructural = new Set();
  const usedBaseline = new Set();

  for (const file of files) {
    const relative = rel(file);
    const contents = fs.readFileSync(file, "utf8");
    if (!ENV_ACCESS.test(contents)) continue;

    if (STRUCTURAL_EXCEPTIONS.has(relative)) {
      usedStructural.add(relative);
      continue;
    }
    if (BASELINE.has(relative)) {
      usedBaseline.add(relative);
      continue;
    }
    violations.push(
      `${relative}: reads process.env directly. Add/read the variable through backend/src/config.ts instead.`,
    );
  }

  const stale = [];
  for (const entry of STRUCTURAL_EXCEPTIONS) {
    if (!usedStructural.has(entry)) {
      stale.push(`${entry}: listed as a structural exception but no longer reads process.env -- remove it.`);
    }
  }
  for (const entry of BASELINE) {
    if (!usedBaseline.has(entry)) {
      stale.push(`${entry}: listed in the baseline but no longer reads process.env -- remove it, the migration moved this one already.`);
    }
  }

  if (violations.length === 0 && stale.length === 0) {
    console.log(
      `Env boundary holds. ${files.length} backend files checked, ` +
        `${STRUCTURAL_EXCEPTIONS.size} structural exceptions, ${BASELINE.size} baseline files remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of stale) console.error(`STALE      ${line}`);
  process.exit(1);
};

module.exports = { STRUCTURAL_EXCEPTIONS, BASELINE, walk, rel, SRC, ALLOWED_FILE, ALLOWED_DIR_PREFIX, ENV_ACCESS };

if (require.main === module) {
  main();
}
