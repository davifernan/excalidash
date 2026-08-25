#!/usr/bin/env node
/**
 * Checks the backend's CORS `allowedHeaders` allowlist against the headers
 * the frontend actually sends (NIL-586).
 *
 * NIL-586's own bug was `If-Match` (NIL-567's optimistic-concurrency header)
 * missing from `backend/src/index.ts`'s `cors({ allowedHeaders: [...] })`.
 * Fixing that one name would have left this check re-deriving the exact
 * report Davi gave twice already today: a symptom fix that stops at the one
 * header somebody happened to trip over, instead of the pattern -- every
 * custom header the frontend sends has to be in the allowlist, not just the
 * one that broke a browser this time. This script finds every custom header
 * literal in `frontend/src` and requires each one to appear (case-insensitively)
 * in the backend's allowlist, so the next missing header fails a check instead
 * of failing a preflight in someone's browser.
 *
 * Same shape as env-boundary.cjs and the other `scripts/*-boundary.cjs`
 * checks: a `main()` that exits 1 with named violations, a small export
 * surface for its counterprobe, and named exceptions instead of a wildcard
 * for anything this script cannot resolve statically.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const FRONTEND_SRC = path.join(root, "frontend", "src");
const CORS_CONFIG_FILE = path.join(root, "backend", "src", "index.ts");

/**
 * CORS-safelisted request headers never need to appear in
 * `Access-Control-Allow-Headers` -- the browser sends them on a simple
 * request without a preflight regardless. Ignored here so a legitimate use
 * of one of these does not force a no-op allowlist entry.
 */
const SAFELISTED_HEADERS = new Set(["accept", "accept-language", "content-language"]);

/**
 * Header names set through `object.headers[someVariable] = value` rather
 * than a string literal. This script reads source text, not types, so a
 * variable key cannot be resolved to its runtime value automatically --
 * each one is a reviewed, named mapping to the header name it actually
 * sends, kept in sync by hand. `frontend/src/api/auth.ts`'s `csrfHeaderName`
 * defaults to `"x-csrf-token"` and is only ever reassigned from the
 * backend's own CSRF bootstrap response, which this repo's contract keeps
 * at `"x-csrf-token"` (already in the allowlist for the string-literal case
 * elsewhere in the same file).
 */
const KNOWN_DYNAMIC_HEADER_VARS = {
  csrfHeaderName: "x-csrf-token",
};

const isTestFile = (relative) =>
  /\.test\.tsx?$/.test(relative) || /\.stories\.tsx?$/.test(relative);

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

/** The allowlist as it actually reads today, parsed from the array literal. */
const readAllowedHeaders = () => {
  const contents = fs.readFileSync(CORS_CONFIG_FILE, "utf8");
  const match = contents.match(/allowedHeaders:\s*\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error(`Could not find an allowedHeaders array in ${rel(CORS_CONFIG_FILE)}`);
  }
  const names = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(`allowedHeaders in ${rel(CORS_CONFIG_FILE)} parsed to an empty list`);
  }
  return new Set(names.map((name) => name.toLowerCase()));
};

/**
 * Balanced-brace extraction of every `headers: { ... }` object literal's raw
 * body. A non-greedy regex breaks the moment a header value itself contains
 * a brace (an inline arrow function, say); this walks braces by hand so a
 * sibling property like `onUploadProgress: (event) => { ... }` next to
 * `headers` cannot fool it.
 */
const extractHeaderBlocks = (contents) => {
  const blocks = [];
  const marker = /headers\s*:\s*\{/g;
  let match;
  while ((match = marker.exec(contents))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < contents.length && depth > 0) {
      if (contents[i] === "{") depth += 1;
      else if (contents[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(contents.slice(start, i - 1));
    marker.lastIndex = i;
  }
  return blocks;
};

const HEADER_KEY =
  /(?:^|[,{])\s*(?:"([A-Za-z][\w-]*)"|'([A-Za-z][\w-]*)'|([A-Za-z_$][\w$-]*))\s*:/g;

const headersFromBlock = (block) =>
  [...block.matchAll(HEADER_KEY)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter(Boolean)
    // A shorthand property (`{ onUploadProgress }`) or a nested value key
    // (e.g. inside a plain object passed as a header value) is not itself a
    // header name; only entries genuinely followed by a `:` inside a
    // `headers: { ... }` block get here, so nothing further to filter.
    .map((name) => name.toLowerCase());

const DYNAMIC_HEADER_ASSIGNMENT = /\.headers\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=/g;

/** Every header name the frontend sends, by source location. */
const collectSentHeaders = () => {
  const found = new Map(); // lowercase header name -> Set of "file:line"
  const record = (name, file, index, contents) => {
    const line = contents.slice(0, index).split("\n").length;
    const set = found.get(name) ?? new Set();
    set.add(`${rel(file)}:${line}`);
    found.set(name, set);
  };

  const unresolvedDynamic = [];

  for (const file of walk(FRONTEND_SRC)) {
    const relative = rel(file);
    if (isTestFile(relative)) continue;
    const contents = fs.readFileSync(file, "utf8");

    for (const block of extractHeaderBlocks(contents)) {
      const blockIndex = contents.indexOf(block);
      for (const name of headersFromBlock(block)) {
        if (SAFELISTED_HEADERS.has(name)) continue;
        record(name, file, blockIndex, contents);
      }
    }

    let dynMatch;
    DYNAMIC_HEADER_ASSIGNMENT.lastIndex = 0;
    while ((dynMatch = DYNAMIC_HEADER_ASSIGNMENT.exec(contents))) {
      const varName = dynMatch[1];
      const resolved = KNOWN_DYNAMIC_HEADER_VARS[varName];
      if (!resolved) {
        unresolvedDynamic.push(
          `${relative}: sets headers[${varName}] with no entry in KNOWN_DYNAMIC_HEADER_VARS -- ` +
            `add one naming the header it actually sends, or this check cannot verify it.`,
        );
        continue;
      }
      record(resolved.toLowerCase(), file, dynMatch.index, contents);
    }
  }

  return { found, unresolvedDynamic };
};

const main = () => {
  if (!fs.existsSync(FRONTEND_SRC)) {
    console.error(`No frontend source at ${FRONTEND_SRC}`);
    process.exit(2);
  }

  const allowed = readAllowedHeaders();
  const { found, unresolvedDynamic } = collectSentHeaders();

  const violations = [];
  for (const [name, locations] of found) {
    if (allowed.has(name)) continue;
    violations.push(
      `${name}: sent by the frontend (${[...locations].join(", ")}) but missing from ` +
        `allowedHeaders in ${rel(CORS_CONFIG_FILE)}.`,
    );
  }
  violations.push(...unresolvedDynamic);

  if (violations.length === 0) {
    console.log(
      `CORS header boundary holds. ${found.size} distinct custom header(s) checked against ` +
        `${allowed.size} allowlisted in ${rel(CORS_CONFIG_FILE)}.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  process.exit(1);
};

module.exports = {
  FRONTEND_SRC,
  CORS_CONFIG_FILE,
  SAFELISTED_HEADERS,
  KNOWN_DYNAMIC_HEADER_VARS,
  readAllowedHeaders,
  extractHeaderBlocks,
  headersFromBlock,
  collectSentHeaders,
};

if (require.main === module) {
  main();
}
