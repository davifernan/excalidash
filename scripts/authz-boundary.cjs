#!/usr/bin/env node
/**
 * Architecture check for the board-ownership boundary (NIL-487).
 *
 * Product code states an authorization intent through backend/src/authz/. Only
 * that directory knows the grant tables, what `Drawing.userId` means, or how a
 * stored string becomes a permission level. This check keeps it that way.
 *
 * The reason is speed, not tidiness. NIL-323 replaces the ownership model.
 * Everything that goes through authz/ survives that rewrite untouched;
 * everything that reaches past it gets rewritten underneath -- and those
 * conflicts merge GREEN and surface in production.
 *
 * The exception lists below are named files, not wildcards. They are the
 * measured starting state and they shrink to nothing. A wildcard would let a
 * new violation hide behind an old one.
 *
 * Every rule is proved in both directions by scripts/authz-boundary.test.cjs:
 * a check nobody has watched fail is not a check.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "backend", "src");
const LAYER = "backend/src/authz";

/**
 * The tables that record who was granted what.
 *
 * Matched on ANY receiver, not on `prisma.`.
 *
 * The inventory in NIL-487 counted 18 raw reads and listed them all as
 * `prisma.drawingPermission` / `prisma.collectionShare`. Measuring again found
 * 22: five of them go through the transaction client instead --
 * `tx.drawingPermission.updateMany` in auth/userOffboarding.ts (three times,
 * which is every grant touch that file makes) and `tx.drawingLinkShare` twice
 * in drawingSharingRoutes.ts.
 *
 * A rule anchored on `prisma.` reports green over all five. That is the same
 * failure the adapter check shipped with -- forbidding the name rather than the
 * use -- and it would have been reintroduced here on the first day.
 */
const GRANT_TABLES = ["drawingPermission", "collectionShare", "drawingLinkShare"];

/**
 * The relation fields that reach the same tables from the other side.
 *
 * `permissions: { some: { granteeUserId } }` reads DrawingPermission without ever
 * naming it, and `permissions: { where: ... }` in a select does the same. The
 * first version of this check listed only the model names, so both walked past
 * it -- the identical mistake the adapter check shipped with, made again one
 * layer down. Found by review, not by me.
 *
 * Matched only when the key opens an object literal. `permissions:
 * grantedLevelSelect(userId)` is the contract handing back the shape, which is
 * the whole point of having one.
 */
const GRANT_RELATIONS = [
  "permissions",
  "linkShares",
  "shares",
  "drawingPermissions",
  "collectionShares",
];

/** The models whose `userId` column IS board ownership. */
const OWNED_MODELS = ["drawing", "collection"];

/**
 * Prisma's query methods.
 *
 * Named explicitly rather than matched as "any method", because the root model
 * of a `where` block is decided by walking back to the nearest query call. A
 * loose pattern there attributes a `where` to the wrong model and the rule
 * either misses or misfires.
 */
const QUERY_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "groupBy",
  "aggregate",
];

/**
 * Files that still read or write a grant table directly.
 *
 * Empty. Every grant decision goes through backend/src/authz/.
 */
const GRANT_TABLE_EXCEPTIONS = new Set([]);

/**
 * Files that still filter a board by `userId` to decide access.
 *
 * Empty. Ownership is answered by getDrawingAccess / getDrawingMembership(s) /
 * controlsDrawing, never by a where-clause in a route.
 */
const OWNERSHIP_FILTER_EXCEPTIONS = new Set([]);

/**
 * Files that still rebuild a permission level out of raw strings.
 *
 * Empty. `normalizeDrawingPermission` is the only thing that turns a stored
 * string into a level, which is what makes adding a level a one-file change.
 */
const LEVEL_RECONSTRUCTION_EXCEPTIONS = new Set([]);

/**
 * Files that still compare a board row's `userId` to decide who owns it.
 *
 * Empty. `Drawing.userId` is not the same question as "who controls this
 * board": a board drawn inside a shared collection belongs to whoever drew it
 * while the collection's owner already controls it. That gap is why the editor
 * once offered a share button that answered 404.
 */
const OWNER_COMPARISON_EXCEPTIONS = new Set([]);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Any receiver, optional chaining, and the bracket form.
 *
 * `prisma.drawingPermission`, `tx.drawingPermission`, `prisma?.drawingPermission`
 * and `prisma["drawingPermission"]` all reach the same table. The adapter check
 * learned this lesson about `api.getSceneElements?.()` after the fact; there is
 * no reason to learn it twice.
 */
const GRANT_TABLE_PATTERNS = [
  ...GRANT_TABLES.flatMap((table) => [
    {
      name: `${table} (property access)`,
      re: new RegExp(`\\??\\.\\s*${escape(table)}\\s*\\??\\s*\\.`),
    },
    { name: `${table} (index access)`, re: new RegExp(`\\[\\s*["'\`]${escape(table)}["'\`]\\s*\\]`) },
  ]),
  ...GRANT_RELATIONS.map((relation) => ({
    name: `${relation} (grant relation)`,
    re: new RegExp(`\\b${escape(relation)}\\s*:\\s*\\{`),
  })),
];

/**
 * A level rebuilt from raw strings instead of read through the contract.
 *
 * Two shapes, both measured in routes/dashboard/collections.ts:
 * `["view", "edit"].includes(role)` validates a level against a hand-written
 * set, and a raw `.role` / `.permission` compared to a literal decides one.
 *
 * Both are how a new level goes missing. `"comment"` is a String in the column;
 * a hand-written set silently rejects it and a raw comparison silently reads it
 * as "not edit" -- which is right by accident today and wrong the moment the
 * ordering matters.
 *
 * Branching on an ALREADY normalized level is not this: drawingSharingRoutes
 * picks a link TTL with `permission === "edit"`, and that value came out of
 * normalizeDrawingPermission. The patterns below require the raw field or the
 * literal set, so policy keyed on a level stays legal.
 */
const LEVEL_NAMES = ["view", "comment", "edit", "owner"];
const LEVEL_ALTERNATION = LEVEL_NAMES.join("|");
const LEVEL_RECONSTRUCTION_PATTERNS = [
  {
    name: "hand-written level set",
    re: new RegExp(
      `\\[\\s*["'\`](?:${LEVEL_ALTERNATION})["'\`]\\s*(?:,\\s*["'\`](?:${LEVEL_ALTERNATION})["'\`]\\s*)+,?\\s*\\]`,
    ),
  },
  {
    name: "raw grant field compared to a level",
    re: new RegExp(`\\.\\s*(?:permission|role)\\s*[!=]==\\s*["'\`](?:${LEVEL_ALTERNATION})["'\`]`),
  },
];

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
};

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

/**
 * Read a balanced `{...}` starting at `open`, respecting strings and comments.
 *
 * A brace counter alone is not enough: a `"}"` inside a string literal or a
 * comment closes the block early and the rest of the object is read as if it
 * were code. That turns a rule that looks precise into one that reports
 * whatever the next few characters happen to be.
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

/**
 * Is `key` one of this block's own keys, in either spelling?
 *
 * `{ userId: req.user.id }` and `{ drawingId, userId }` are the same filter,
 * and the first version of this rule required the colon -- so the shorthand
 * walked straight past it. The counterprobe caught that before the rule ever
 * reported green, which is the entire reason it plants violations instead of
 * trusting the author.
 *
 * Key position is checked rather than mere presence, so `{ id: userId }` --
 * filtering by id with a variable that happens to be called userId -- is not
 * mistaken for a filter on the column.
 */
const hasOwnKey = (body, key) =>
  topLevelOf(body)
    .split(",")
    .some((part) => new RegExp(`^\\s*${key}\\s*(?::|$)`).test(part));

/** Strip nested `{...}` so a key search only sees this block's own keys. */
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

const QUERY_CALL = new RegExp(
  `\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\??\\s*\\.\\s*(?:${QUERY_METHODS.join("|")})\\s*\\(`,
  "g",
);

/** The model a `where` block belongs to: the nearest query call before it. */
const rootModelBefore = (source, position) => {
  QUERY_CALL.lastIndex = 0;
  let model = null;
  let match;
  while ((match = QUERY_CALL.exec(source)) !== null) {
    if (match.index >= position) break;
    model = match[1];
  }
  return model;
};

/**
 * Board-ownership filters: a `where` that decides access by `userId`.
 *
 * Deliberately narrower than "any userId". Three kinds of hit look alike and
 * only one belongs behind this boundary:
 *
 *   decision  `where: { id, userId: req.user.id }` on drawing/collection
 *   grant     `data: { userId: req.user.id }` on create -- sets ownership,
 *             decides nothing, and is untouched here
 *   account   password, API keys, profile, admin user management, s3File --
 *             a different question entirely
 *
 * Only `where` blocks are read, and only on the two owned models, so the second
 * and third kinds never reach the rule. A rule wide enough to catch all three
 * would go red on correct code, and one that goes red on correct code trains
 * people to walk past red exactly as surely as one that stays green on wrong
 * code.
 *
 * The relation form counts too: exportRoutes.ts filters other models by
 * `where: { drawing: { userId } }`, which is the same decision one hop away.
 */
/**
 * A where-clause built as a named variable rather than inline at the call.
 *
 * `const where: Prisma.DrawingWhereInput = { userId: req.user.id }` is the same
 * ownership decision as writing it inside `findMany`, and the first version of
 * this rule -- anchored on `where:` immediately followed by `{` -- saw neither
 * that nor `whereDrawing`. Both sat unmigrated in the core "list my boards"
 * query while the check reported zero exceptions. Review found it; the
 * counterprobe had never planted the form.
 *
 * The Prisma type annotation is the anchor, not the variable name. A name can
 * be anything; the annotation is what makes the object a board filter.
 */
const findAnnotatedWhereFilters = (source) => {
  const hits = [];
  const re = /:\s*Prisma\.(Drawing|Collection)WhereInput\s*=\s*\{/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = source.indexOf("{", match.index + match[0].length - 1);
    const block = readBlock(source, open);
    // `userId: { not: me }` is an ownership decision too -- the negated half of
    // "shared with me" is still the same column deciding the same thing.
    if (block && hasOwnKey(block.body, "userId")) {
      hits.push(`declares a ${match[1].toLowerCase()} ownership filter as a variable`);
    }
  }
  return hits;
};

const findOwnershipFilters = (source) => {
  const hits = [...findAnnotatedWhereFilters(source)];
  const whereRe = /\bwhere\s*:\s*\{/g;
  let match;
  while ((match = whereRe.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    const block = readBlock(source, open);
    if (!block) continue;

    const model = rootModelBefore(source, match.index);
    if (model && OWNED_MODELS.includes(model) && hasOwnKey(block.body, "userId")) {
      hits.push(`filters ${model} by userId`);
      continue;
    }

    for (const owned of OWNED_MODELS) {
      const relationRe = new RegExp(`\\b${owned}\\s*:\\s*\\{`, "g");
      let relation;
      while ((relation = relationRe.exec(block.body)) !== null) {
        const relationOpen = block.body.indexOf("{", relation.index);
        const relationBlock = readBlock(block.body, relationOpen);
        if (relationBlock && hasOwnKey(relationBlock.body, "userId")) {
          hits.push(`filters by ${owned}.userId through a relation`);
        }
      }
    }
  }
  return hits;
};

/**
 * `existing.userId !== req.user.id` -- ownership decided from the raw column.
 *
 * Scoped by where the value came from, not by the field name. Nine other
 * `.userId ===` comparisons in the backend are about a JWT payload, a stored
 * refresh token, a socket principal or a roster member, and none of them is a
 * board-ownership decision. A rule that matched the field would flag all nine.
 *
 * So bindings are collected first: a name is a board record only if it was
 * assigned from a drawing/collection query in this file. The two literal names
 * are included because a loop variable called `drawing` is the same thing.
 */
const findOwnerComparisons = (source) => {
  const bindings = new Set(OWNED_MODELS);
  const bindingRe = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?[A-Za-z_$][\\w$]*\\s*\\??\\s*\\.\\s*(?:${OWNED_MODELS.join("|")})\\s*\\.\\s*(?:${QUERY_METHODS.join("|")})\\s*\\(`,
    "g",
  );
  let match;
  while ((match = bindingRe.exec(source)) !== null) bindings.add(match[1]);

  const hits = [];
  for (const name of bindings) {
    // `board.userId`, `board?.userId` and `board!.userId` are one access.
    // This codebase writes `req.user!.id` everywhere, so the assertion form is
    // not hypothetical -- and the first version of this pattern, which allowed
    // only the optional-chaining variant, was green over it.
    const field = `\\b${escape(name)}\\s*[!?]?\\s*\\.\\s*userId`;
    // Both directions. `principal.userId === drawing.userId` in
    // drawingReadRoutes.ts is the same decision as `existing.userId !== ...`,
    // and a rule anchored on "field, then operator" reads straight past it --
    // which it did, on the first run against the unmigrated tree.
    const re = new RegExp(`${field}\\s*[!=]==|[!=]==\\s*${field}`);
    if (re.test(source)) hits.push(`decides ownership from ${name}.userId`);
  }
  return hits;
};

const RULES = [
  {
    id: "grant-table-access",
    exceptions: GRANT_TABLE_EXCEPTIONS,
    find: (source) => {
      const hit = GRANT_TABLE_PATTERNS.find(({ re }) => re.test(source));
      return hit ? [hit.name] : [];
    },
    message:
      "reads or writes a grant table directly. Go through backend/src/authz/ " +
      "(getDrawingAccess, getDrawingMembership(s), getDrawingRosters, controlsDrawing).",
  },
  {
    id: "ownership-filter",
    exceptions: OWNERSHIP_FILTER_EXCEPTIONS,
    find: findOwnershipFilters,
    message:
      "decides board ownership with a userId filter. Ask backend/src/authz/ instead; " +
      "NIL-323 replaces this model and only the contract survives it.",
  },
  {
    id: "level-reconstruction",
    exceptions: LEVEL_RECONSTRUCTION_EXCEPTIONS,
    find: (source) => {
      const hit = LEVEL_RECONSTRUCTION_PATTERNS.find(({ re }) => re.test(source));
      return hit ? [hit.name] : [];
    },
    message:
      "rebuilds a permission level from raw strings. Use normalizeDrawingPermission " +
      "and the DrawingAccess predicates.",
  },
  {
    id: "owner-comparison",
    exceptions: OWNER_COMPARISON_EXCEPTIONS,
    find: findOwnerComparisons,
    message:
      "decides ownership by comparing a board row's userId. Use isOwnerAccess(getDrawingAccess(...)) " +
      "or controlsDrawing -- the row's userId is not the same question.",
  },
];

/**
 * Fixtures are not decisions.
 *
 * Test files seed grant rows to arrange a situation. Forcing that through the
 * contract would mean the contract is verified with the contract, which proves
 * nothing. Routes live in neither of these shapes, so nothing hides here.
 */
const isTestFile = (relative) =>
  /\.test\.ts$/.test(relative) ||
  /\.integration\.ts$/.test(relative) ||
  relative.includes("/__tests__/");

/**
 * The generated Prisma client is not product code.
 *
 * It declares every table, so it names the grant tables by construction and
 * trips the first rule on a tree nobody has touched. Listing it as an exception
 * would be wrong twice: it is not a violation to fix, and a permanent entry on
 * a list that must reach zero is a wildcard wearing a filename.
 */
const isGenerated = (relative) => relative.startsWith("backend/src/generated/");

const main = () => {
  if (!fs.existsSync(SRC)) {
    console.error(`No backend source at ${SRC}`);
    process.exit(2);
  }

  const files = walk(SRC).filter((file) => !isTestFile(rel(file)) && !isGenerated(rel(file)));
  const violations = [];
  const usedExceptions = new Map(RULES.map((rule) => [rule.id, new Set()]));

  for (const file of files) {
    const relative = rel(file);
    if (relative.startsWith(`${LAYER}/`)) continue;
    const contents = fs.readFileSync(file, "utf8");

    for (const rule of RULES) {
      const found = rule.find(contents);
      if (found.length === 0) continue;
      if (rule.exceptions.has(relative)) {
        usedExceptions.get(rule.id).add(relative);
        continue;
      }
      violations.push(`${relative}: ${rule.message} (${found[0]})`);
    }
  }

  /**
   * A stale exception is a violation too. It means a file was migrated and
   * nobody removed its licence to misbehave -- which quietly widens the hole
   * again the next time somebody edits that file.
   */
  const stale = [];
  for (const rule of RULES) {
    for (const entry of rule.exceptions) {
      if (!usedExceptions.get(rule.id).has(entry)) {
        stale.push(`${entry}: listed as a ${rule.id} exception but no longer needs one.`);
      }
    }
  }

  if (violations.length === 0 && stale.length === 0) {
    const total = RULES.reduce((n, rule) => n + rule.exceptions.size, 0);
    console.log(
      `Authz boundary holds. ${files.length} files checked, ${total} named exceptions remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of stale) console.error(`STALE      ${line}`);
  process.exit(1);
};

module.exports = { RULES, SRC };

if (require.main === module) main();
