#!/usr/bin/env node
/**
 * Architecture check for the agent-token centralization (NIL-382/NIL-503).
 *
 * Two guarantees NIL-382 built by hand, not by construction, and both would
 * still merge green the day someone works around them:
 *
 *   1. Only auth/apiKeys.ts#resolveApiKeyUser authenticates a bearer token by
 *      looking it up in the ApiKey table. It is the one place that reads
 *      drawingId off the row and turns it into "this is an agent token,
 *      confined to one board" -- shared by both auth entry points (HTTP
 *      middleware/auth.ts, socket server/socketAuth.ts) for exactly that
 *      reason. A second lookup elsewhere, keyed the same way (by keyId, the
 *      field extracted from an incoming token), is a second place the
 *      drawingId check can be half-built, forgotten on one path, or built
 *      correctly today and drift the day someone edits it without noticing
 *      its twin.
 *
 *   2. Every route registered under `/drawings/:id/agent/...` is one
 *      middleware/auth.ts#getAgentRouteDrawingId already recognizes. A route
 *      living at that path but unknown to the recognizer is unreachable by
 *      an agent token today -- which sounds safe until the next person
 *      "fixes" that by authenticating it a different way, or until the
 *      route is meant to be agent-reachable and nobody notices it silently
 *      is not.
 *
 * Rule 2 is derived from the routes actually registered, not a hand-
 * maintained list of "the three agent routes" -- the same shape as
 * scripts/real-auth-boundary.cjs's REAL_AUTH_SPECS derivation, and for the
 * same reason: a maintained list is a claim about the code, and the two
 * drift the moment one changes without the other.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "backend", "src");
const RESOLVER_FILE = "backend/src/auth/apiKeys.ts";
const AUTH_MIDDLEWARE_FILE = "backend/src/middleware/auth.ts";

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
};

const isTestFile = (relative) =>
  /\.test\.ts$/.test(relative) ||
  /\.integration\.ts$/.test(relative) ||
  relative.includes("/__tests__/");
const isGenerated = (relative) => relative.startsWith("backend/src/generated/");

/**
 * Read a balanced `{...}` starting at `open`, respecting strings/comments.
 * Same shape as authz-boundary.cjs's readBlock -- a brace counter alone
 * closes early on a `}` inside a string or comment.
 */
const readBlock = (source, open) => {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === ch) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i };
    }
    i += 1;
  }
  return null;
};

const topLevelOf = (body) => {
  let out = "";
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
};

const hasOwnKey = (body, key) =>
  topLevelOf(body)
    .split(",")
    .some((part) => new RegExp(`^\\s*${key}\\s*(?::|$)`).test(part));

/**
 * Files allowed to look an ApiKey row up by keyId -- i.e. to authenticate an
 * incoming bearer token. Empty: resolveApiKeyUser is the only one.
 */
const KEYID_LOOKUP_EXCEPTIONS = new Set([]);

/**
 * A `something.apiKey.findX({ where: { keyId ... } })` call: the shape that
 * turns a raw bearer token into a database row. `keyId` is only ever
 * produced by extractApiKeyId(token) -- nothing else has a reason to filter
 * the ApiKey table by it, so a query keyed this way IS a second
 * authentication path, wherever it appears. Contrast the queries this
 * deliberately leaves alone: `where: { id }` (revocation/admin lookups by
 * primary key), `where: { userId }` (listing an account's own keys) -- both
 * measured in auth/accountApiKeyRoutes.ts, auth/adminUserRoutes.ts,
 * server/socketCredentials.ts, auth/userCredentialRevocation.ts, none of
 * which authenticate a token.
 */
const findKeyIdLookups = (source) => {
  const hits = [];
  // Matches up to and including the `{` that opens the call's argument
  // object -- `findUnique({`, with any amount of whitespace/newlines
  // between the `(` and the `{`, which is how this codebase formats a
  // multi-line call.
  const callRe = /\.\s*apiKey\s*\.\s*find(?:Unique|First)(?:OrThrow)?\s*\(\s*\{/g;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const braceOpen = match.index + match[0].length - 1;
    const outer = readBlock(source, braceOpen);
    if (!outer) continue;
    const whereMatch = /\bwhere\s*:\s*\{/.exec(outer.body);
    if (!whereMatch) continue;
    const whereOpen = braceOpen + 1 + whereMatch.index + whereMatch[0].length - 1;
    const whereBlock = readBlock(source, whereOpen);
    if (whereBlock && hasOwnKey(whereBlock.body, "keyId")) {
      hits.push("apiKey lookup keyed by keyId");
    }
  }
  return hits;
};

/**
 * Parse getAgentRouteDrawingId's recognized (method, action) pairs out of
 * middleware/auth.ts. Each recognized line has the shape
 * `action === "NAME" && (isReadMethod(method) | method === "METHOD")`.
 * Missing the function entirely is an error, not an empty result -- a typo'd
 * rename must not silently read as "recognizes nothing", which would make
 * every registered agent route look unrecognized instead of naming the real
 * break.
 */
const parseRecognizedAgentRoutes = (source) => {
  const fnMatch = /const\s+getAgentRouteDrawingId\s*=\s*\(/.exec(source);
  if (!fnMatch) {
    throw new Error(`${AUTH_MIDDLEWARE_FILE}: getAgentRouteDrawingId not found -- was it renamed?`);
  }
  // Not the first `{` after the match: this function's signature carries a
  // `): { drawingId: ...; scope: ... } | null =>` return-type annotation, and
  // that object-type literal's `{` sits before the real body. The `{` right
  // after the arrow is always the body -- an arrow function's return type
  // (if any) is always between `)` and `=>`, never after it.
  const arrowIndex = source.indexOf("=>", fnMatch.index);
  if (arrowIndex === -1) {
    throw new Error(`${AUTH_MIDDLEWARE_FILE}: getAgentRouteDrawingId has no arrow -- not an arrow function?`);
  }
  const braceOpen = source.indexOf("{", arrowIndex);
  const block = readBlock(source, braceOpen);
  if (!block) throw new Error(`${AUTH_MIDDLEWARE_FILE}: could not read getAgentRouteDrawingId's body`);

  const recognized = new Set();
  const lineRe =
    /action\s*===\s*"([\w-]+)"[^;\n]*?(?:isReadMethod\(method\)|method\s*===\s*"([A-Z]+)")/g;
  let match;
  while ((match = lineRe.exec(block.body)) !== null) {
    const action = match[1];
    if (match[2]) {
      recognized.add(`${match[2]}:${action}`);
    } else {
      recognized.add(`GET:${action}`);
      recognized.add(`HEAD:${action}`);
    }
  }
  return recognized;
};

/**
 * Every `app.<method>("/drawings/:id/agent/<action>", ...)` (or any drawing
 * id param name -- `:id` is not the only one used in this codebase) actually
 * registered anywhere under backend/src/routes. Not scoped to
 * drawingAgentRoutes.ts on purpose: the whole point is to catch an agent
 * route registered somewhere else, which by definition would not be in the
 * one file someone remembered to check.
 */
const findRegisteredAgentRoutes = (source, hitFile, registry) => {
  const routeRe =
    /\bapp\s*\.\s*(get|post|put|delete|patch)\s*\(\s*["'`]\/drawings\/:\w+\/agent\/([\w-]*)["'`]/g;
  let match;
  while ((match = routeRe.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const action = match[2];
    // Express answers HEAD for any GET route unless a separate HEAD handler
    // exists (none do here), so an `app.get(...)` registration covers both --
    // recognizing HEAD without a route registering it as such is not stale,
    // it is Express's own routing behavior.
    const methods = method === "GET" ? ["GET", "HEAD"] : [method];
    for (const m of methods) {
      const key = `${m}:${action}`;
      if (!registry.has(key)) registry.set(key, []);
      registry.get(key).push(hitFile);
    }
  }
};

const main = () => {
  if (!fs.existsSync(SRC)) {
    console.error(`No backend source at ${SRC}`);
    process.exit(2);
  }

  const files = walk(SRC).filter((file) => !isTestFile(rel(file)) && !isGenerated(rel(file)));

  // ---- Rule 1: keyId-keyed ApiKey lookups only in the resolver ----
  const violations = [];
  const usedKeyIdExceptions = new Set();
  for (const file of files) {
    const relative = rel(file);
    if (relative === RESOLVER_FILE) continue;
    const hits = findKeyIdLookups(fs.readFileSync(file, "utf8"));
    if (hits.length === 0) continue;
    if (KEYID_LOOKUP_EXCEPTIONS.has(relative)) {
      usedKeyIdExceptions.add(relative);
      continue;
    }
    violations.push(
      `${relative}: looks an ApiKey row up by keyId outside auth/apiKeys.ts#resolveApiKeyUser ` +
        `(${hits[0]}). This is a second bearer-token authentication path -- ` +
        "route it through resolveApiKeyUser instead.",
    );
  }
  const staleKeyIdExceptions = [...KEYID_LOOKUP_EXCEPTIONS].filter(
    (entry) => !usedKeyIdExceptions.has(entry),
  );

  // ---- Rule 2: every registered agent route is recognized ----
  const middlewarePath = path.join(root, AUTH_MIDDLEWARE_FILE);
  if (!fs.existsSync(middlewarePath)) {
    console.error(`${AUTH_MIDDLEWARE_FILE} not found`);
    process.exit(2);
  }
  const recognized = parseRecognizedAgentRoutes(fs.readFileSync(middlewarePath, "utf8"));

  const registered = new Map();
  const routesDir = path.join(SRC, "routes");
  for (const file of walk(routesDir).filter((f) => !isTestFile(rel(f)))) {
    findRegisteredAgentRoutes(fs.readFileSync(file, "utf8"), rel(file), registered);
  }

  const unrecognizedRoutes = [];
  for (const [key, hitFiles] of registered) {
    if (!recognized.has(key)) {
      const [method, action] = key.split(":");
      unrecognizedRoutes.push(
        `${hitFiles[0]}: registers ${method} .../agent/${action} but ` +
          `${AUTH_MIDDLEWARE_FILE}'s getAgentRouteDrawingId does not recognize it -- ` +
          "an agent token can never reach this route today, which is only safe by accident.",
      );
    }
  }

  const staleRecognized = [...recognized].filter((key) => !registered.has(key));

  const hasViolations = violations.length > 0 || unrecognizedRoutes.length > 0;
  const hasStale = staleKeyIdExceptions.length > 0 || staleRecognized.length > 0;

  if (!hasViolations && !hasStale) {
    console.log(
      `Agent token boundary holds. ${files.length} files checked, ` +
        `${registered.size} agent route(s) registered and recognized, ` +
        `${KEYID_LOOKUP_EXCEPTIONS.size} named exceptions remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of unrecognizedRoutes) console.error(`VIOLATION  ${line}`);
  for (const entry of staleKeyIdExceptions) {
    console.error(`STALE      ${entry}: listed as a keyId-lookup exception but no longer needs one.`);
  }
  for (const key of staleRecognized) {
    const [method, action] = key.split(":");
    console.error(
      `STALE      ${AUTH_MIDDLEWARE_FILE}: recognizes ${method} .../agent/${action} but no route registers it.`,
    );
  }
  process.exit(1);
};

module.exports = {
  SRC,
  RESOLVER_FILE,
  AUTH_MIDDLEWARE_FILE,
  findKeyIdLookups,
  parseRecognizedAgentRoutes,
  findRegisteredAgentRoutes,
};

if (require.main === module) main();
