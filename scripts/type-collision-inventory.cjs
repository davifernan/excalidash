#!/usr/bin/env node
/**
 * Inventory of structurally-assignable string-literal-union types (NIL-489,
 * Klasse 1 + Klasse 2).
 *
 * TypeScript is structural: two differently-named types built from the same
 * (or overlapping) string literals are interchangeable at any call site,
 * silently. `CollectionShareRole` and `DrawingPermission` answer two
 * different questions -- "what can this share link do to a collection" and
 * "what can this principal do to a board" -- but nothing stops one from being
 * handed to a parameter typed as the other. That is the failure class this
 * measures: "gemessen, nicht vermutet" (NIL-489) means an actual resolver
 * over the real declarations, not a remembered list from the day someone
 * last looked.
 *
 * Two distinct causes produce the same symptom and need different fixes:
 *
 *   Klasse 1  A whole cluster of authorization levels is built by extending
 *             the same string alphabet ("view" | "comment" | "edit", plus
 *             "owner", plus "none"). Renaming does nothing here -- the sets
 *             stay assignable no matter what the types are called. The real
 *             fix is nominal types (branding), out of scope for this check
 *             and for this package; see the BASELINE entries below and
 *             NIL-489's "Zeitpunkt" section for why it waits.
 *
 *   Klasse 2  One concept, declared twice because nobody reused the first
 *             declaration -- overwhelmingly across the frontend/backend
 *             boundary, where there is no shared package to import from. The
 *             fix is a single source; the PR for NIL-498 did this for
 *             `WidgetKind`/`UploadDocumentKind` (both frontend, cheap) and
 *             left every pair that crosses the frontend/backend split on the
 *             BASELINE, because consolidating any of them needs a shared
 *             package between the two projects first, which is its own
 *             decision -- see the BASELINE comment above that group.
 *
 * A third shape, not named in NIL-489's own text but found by running this
 * script: two types that share no concept and no import relationship at all,
 * whose literals happen to overlap (`TeamRole` / `PresenceKind`). Structurally
 * identical to Klasse 1 -- only nominal types close it -- but arrived at by
 * accident rather than by one alphabet being deliberately extended.
 *
 * A type that is a bare re-export of another (`export type A = B;`, no
 * literal of its own) is not counted here. It cannot drift: it IS the other
 * type, by reference, forever. `AssetWidgetKind = WidgetKind` in
 * pdfWidgetElements.ts is exactly this and is deliberately not flagged.
 *
 * What this script cannot see, by design: object/mapped/conditional types,
 * numeric or boolean unions, anything imported from outside frontend/src or
 * backend/src (a node_modules type, `@excalidraw/excalidraw`'s own types).
 * Widening the resolver to those is possible but was not needed to reproduce
 * -- and, on the frontend/backend pairs above, exceed -- NIL-489's own
 * finding, and a resolver that silently guesses at types it cannot fully
 * parse is more dangerous than one that says so and moves on.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ROOTS = [path.join(root, "frontend", "src"), path.join(root, "backend", "src")];

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

const isTestFile = (relative) =>
  /\.test\.tsx?$/.test(relative) ||
  /\.integration\.tsx?$/.test(relative) ||
  relative.includes("/__tests__/");

const isGenerated = (relative) => relative.startsWith("backend/src/generated/");

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
};

/**
 * Read forward from `start` to the matching top-level `;`, respecting
 * strings, comments and `(){}[]` nesting -- the same shape as
 * authz-boundary.cjs's `readBlock`, adapted to a `;`-terminated statement
 * instead of a `{...}` block. `<>` is deliberately not tracked: none of the
 * type aliases this resolver can otherwise understand use generics, and a
 * `Record<Foo, Bar>` (which this resolver bails out on anyway, see below)
 * never contains a `;` inside its angle brackets that could be mistaken for
 * the statement end.
 */
const readStatement = (source, start) => {
  let depth = 0;
  let i = start;
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
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === ";" && depth === 0) return source.slice(start, i);
    i += 1;
  }
  return null;
};

/** Split `text` on top-level `|`, the same depth/string/comment rules as readStatement. */
const splitTopLevelUnion = (text) => {
  const parts = [];
  let depth = 0;
  let segStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    else if (ch === "|" && depth === 0) {
      parts.push(text.slice(segStart, i));
      segStart = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(segStart));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

const STRING_LITERAL = /^(["'])((?:[^\\]|\\.)*)\1$/;
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * `export type Name = ...;` and `export type Name<...> = ...;` (the latter is
 * intentionally unresolved).
 *
 * A factory, not a shared module-level RegExp: `collectCandidates` walks
 * matches of this pattern in a file while, for each match, recursively
 * resolving a type that can itself scan the *same* file again (a local
 * reference, or an import cycle back to this file). A single shared `g`
 * RegExp's `lastIndex` is exactly the kind of state that recursion corrupts
 * -- the inner scan would silently rewind or skip the outer one's position.
 * Measured: without this, a file's second `export type` after one that
 * triggers a recursive resolve went missing from the inventory entirely.
 */
const typeAliasPattern = () => /export\s+type\s+([A-Za-z_$][\w$]*)\s*(<[^=]*)?=\s*/g;

const importLinePattern = () =>
  /import\s+type\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']|import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** `{ Foo, type Bar as Baz, ... }` -> Map<localName, { imported, path }>. */
const parseImports = (source) => {
  const bindings = new Map();
  let match;
  const importLine = importLinePattern();
  while ((match = importLine.exec(source)) !== null) {
    const specifiers = match[1] ?? match[3];
    const fromPath = match[2] ?? match[4];
    for (const raw of specifiers.split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const asMatch = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const imported = asMatch ? asMatch[1] : spec;
      const local = asMatch ? asMatch[2] : spec;
      bindings.set(local, { imported, path: fromPath });
    }
  }
  return bindings;
};

const resolveImportFile = (fromFile, importPath) => {
  if (!importPath.startsWith(".")) return null; // package import, out of scope
  const base = path.resolve(path.dirname(fromFile), importPath);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return null;
  if (!ROOTS.some((r) => found.startsWith(`${r}${path.sep}`) || found === r)) return null;
  return found;
};

/**
 * Per-file cache of `{ source, imports, aliasStarts }` so a file that is
 * imported by several others is only read and scanned for declarations once.
 */
const fileCache = new Map();
const readFile = (file) => {
  if (fileCache.has(file)) return fileCache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const imports = parseImports(source);
  const entry = { source, imports };
  fileCache.set(file, entry);
  return entry;
};

/** name -> resolved entry, keyed by `${file}::${name}`, across the whole run. */
const resolved = new Map();
const inProgress = new Set();

/**
 * Resolve one `export type Name = ...` in `file` to its literal set.
 *
 * Returns `null` when the RHS contains anything this resolver does not
 * understand (an object type, `keyof`, a template literal, a generic, an
 * import this resolver cannot follow) -- "unresolved" is a real outcome, not
 * a bug, and callers must treat it as "cannot say", not as "empty set".
 */
const resolveType = (file, name) => {
  const key = `${file}::${name}`;
  if (resolved.has(key)) return resolved.get(key);
  if (inProgress.has(key)) return null; // cyclic reference
  inProgress.add(key);

  const result = resolveTypeUncached(file, name);
  inProgress.delete(key);
  resolved.set(key, result);
  return result;
};

const resolveTypeUncached = (file, name) => {
  const { source, imports } = readFile(file);
  const rhs = findAliasRhs(source, name);
  if (rhs !== undefined) {
    // Declared locally but generic or otherwise unparseable: bail rather
    // than falling through to an import of the same name, which would
    // silently resolve the wrong declaration.
    if (rhs === null) return null;
    return resolveExpression(rhs, file, name);
  }

  const binding = imports.get(name);
  if (!binding) return null;
  const importedFile = resolveImportFile(file, binding.path);
  if (!importedFile) return null;
  return resolveType(importedFile, binding.imported);
};

/**
 * Find `export type NAME = <rhs>;` in `source`.
 *
 * Three outcomes, and they must stay distinguishable: `undefined` means no
 * such declaration exists in this file (the caller should look at imports
 * instead), `null` means one exists but this resolver cannot read it
 * (generic, or `readStatement` could not find the terminating `;` --
 * matters, since a shadowing local declaration must not fall through to an
 * import of the same name), and a string is the RHS text to resolve.
 */
const findAliasRhs = (source, name) => {
  const typeAlias = typeAliasPattern();
  let match;
  while ((match = typeAlias.exec(source)) !== null) {
    if (match[1] !== name) continue;
    if (match[2]) return null; // `export type Name<T> = ...` -- generic, not a plain alias
    return readStatement(source, typeAlias.lastIndex); // null on unterminated statement
  }
  return undefined; // no such declaration in this file
};

const resolveExpression = (rhs, file, ownerName) => {
  const segments = splitTopLevelUnion(rhs);
  if (segments.length === 0) return null;

  const literals = new Set();
  let isPureAlias = false;
  if (segments.length === 1 && !STRING_LITERAL.test(segments[0])) {
    if (!BARE_IDENTIFIER.test(segments[0])) return null;
    isPureAlias = true;
  }

  for (const segment of segments) {
    const literalMatch = segment.match(STRING_LITERAL);
    if (literalMatch) {
      literals.add(literalMatch[2]);
      continue;
    }
    if (!BARE_IDENTIFIER.test(segment)) return null; // object type, generic, keyof, template, ...
    if (segment === ownerName) return null; // self-reference guard, should not happen
    const referenced = resolveType(file, segment);
    if (referenced === null) return null;
    for (const literal of referenced.literals) literals.add(literal);
  }

  if (literals.size === 0) return null;
  return { literals, isPureAlias };
};

const collectCandidates = () => {
  const files = ROOTS.flatMap((r) => walk(r)).filter((file) => {
    const relative = rel(file);
    return !isTestFile(relative) && !isGenerated(relative);
  });

  const candidates = [];
  for (const file of files) {
    const { source } = readFile(file);
    const typeAlias = typeAliasPattern();
    let match;
    const seen = new Set();
    while ((match = typeAlias.exec(source)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue; // a re-declared name in one file is a syntax error anyway
      seen.add(name);
      const result = resolveType(file, name);
      if (result && !result.isPureAlias) {
        candidates.push({ name, file: rel(file), literals: result.literals });
      }
    }
  }
  return candidates;
};

const setsEqual = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));
const isSubset = (a, b) => [...a].every((value) => b.has(value));

const findCollisions = (candidates) => {
  const collisions = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.name === b.name && a.file === b.file) continue;
      let relation;
      if (setsEqual(a.literals, b.literals)) relation = "identical";
      else if (isSubset(a.literals, b.literals)) relation = `${a.name} ⊆ ${b.name}`;
      else if (isSubset(b.literals, a.literals)) relation = `${b.name} ⊆ ${a.name}`;
      else continue;
      collisions.push({
        a: `${a.name} (${a.file})`,
        b: `${b.name} (${b.file})`,
        relation,
        key: [a.name, b.name].sort().join(" / "),
      });
    }
  }
  return collisions;
};

/**
 * Known, accepted collisions -- the inventory NIL-489 asked for, kept alive
 * as a gate rather than a paragraph. Each entry names both types, the class
 * (see file header) and why it is not fixed by this check's own PR.
 *
 * This list SHRINKS as debt is paid off (remove the entry when a pair stops
 * colliding -- a stale entry here is caught below, same as
 * authz-boundary.cjs's stale-exception handling) and must never grow silently:
 * a real new collision fails the check until it is either fixed or added here
 * with a reason, by a reviewed change to this file.
 */
const BASELINE = [
  {
    key: "PresenceKind / TeamRole",
    reason:
      "Accidental, not a shared concept: TeamRole (backend/src/authz/team.ts, a member's role " +
      "in a team) happens to be a subset of PresenceKind's (backend/src/server/" +
      "presenceRegistry.ts, why a socket connection is present) literals. Different questions, " +
      "no import relationship, nothing to consolidate -- would need nominal types to close, " +
      "same as the Klasse 1 authz cluster above. Found by this script, not anticipated by " +
      "NIL-489's own text; reported as a comment on NIL-489 rather than fixed here.",
  },
  /**
   * The next six pairs are one root cause, not six: this codebase has no shared types
   * package between frontend and backend, so a value that crosses the socket or REST
   * boundary gets its literal union declared once on each side. `DrawingSortField`/
   * `SortField` is the instance NIL-489 already named; the other five were found by
   * running this script, not anticipated by NIL-489's own text, and are reported as a
   * comment on NIL-489 rather than fixed here -- consolidating any one of them the same
   * way `WidgetKind`/`UploadDocumentKind` was fixed (NIL-498, entirely inside frontend)
   * is not available: there is nowhere on the backend side to import a frontend type
   * from, or vice versa, without introducing that shared package first. That is a
   * decision bigger than this check, and bigger than renaming.
   */
  {
    key: "DrawingSortField / SortField",
    reason: "frontend/src/api/drawings.ts vs backend/src/routes/dashboard/types.ts.",
  },
  {
    key: "SortDirection / SortDirection",
    reason: "Same file pair as DrawingSortField/SortField, declared alongside it on both sides.",
  },
  {
    key: "PresenterStatus / PresenterStatus",
    reason:
      "frontend/src/pages/editor/presenterMode.ts vs backend/src/server/presenterRegistry.ts.",
  },
  {
    key: "VotingStatus / VotingStatus",
    reason: "frontend/src/pages/editor/votingMode.ts vs backend/src/server/votingRegistry.ts.",
  },
  {
    key: "WorkshopTimerStatus / WorkshopTimerStatus",
    reason:
      "frontend/src/pages/editor/workshopTimer.ts vs backend/src/server/socketWorkshopTimer.ts.",
  },
  {
    key: "WorkshopTimerAction / WorkshopTimerAction",
    reason:
      "frontend/src/pages/editor/workshopTimer.ts vs backend/src/server/socketWorkshopTimer.ts.",
  },
  {
    key: "CollectionShareRole / CollectionShareRole",
    reason:
      "frontend/src/types/index.ts vs backend/src/authz/sharing.ts. The backend side is new " +
      "(NIL-502): the two collection-share routes used to validate a share's role against the " +
      'wider DrawingPermission alphabet ("view" | "comment" | "edit") while their own error ' +
      'messages claimed "view" or "edit" only, matching the narrower frontend ' +
      'CollectionShareRole -- so a raw request naming role: "comment" was silently accepted. ' +
      "Fixed by giving the backend its own CollectionShareRole, same name and alphabet as the " +
      "frontend's on purpose, and using it (not DrawingPermission) in grantCollectionShare, " +
      "changeCollectionShareRole, and both routes. That closes the CollectionShareRole/" +
      "DrawingPermission gap (see that baseline entry above) but is itself the same Klasse 2 " +
      "shape as the seven pairs below it: one concept, declared once per side of the frontend/" +
      "backend boundary because there is no shared package to import from.",
  },
];
const BASELINE_KEYS = new Set(BASELINE.map((entry) => entry.key));

const main = () => {
  const candidates = collectCandidates();
  const collisions = findCollisions(candidates);
  const foundKeys = new Set(collisions.map((entry) => entry.key));

  const unbaselined = collisions.filter((entry) => !BASELINE_KEYS.has(entry.key));
  const stale = BASELINE.filter((entry) => !foundKeys.has(entry.key));

  if (unbaselined.length === 0 && stale.length === 0) {
    console.log(
      `Type-collision inventory holds. ${candidates.length} resolvable string-union types ` +
        `checked, ${BASELINE.length} baselined collisions remaining.`,
    );
    process.exit(0);
  }

  for (const entry of unbaselined) {
    console.error(
      `NEW COLLISION  ${entry.a} and ${entry.b} are structurally assignable (${entry.relation}). ` +
        "Fix it (rename/brand/consolidate) or add a justified BASELINE entry in " +
        "scripts/type-collision-inventory.cjs.",
    );
  }
  for (const entry of stale) {
    console.error(
      `STALE BASELINE  "${entry.key}" is listed but no longer collides -- remove the entry.`,
    );
  }
  process.exit(1);
};

module.exports = {
  ROOTS,
  collectCandidates,
  findCollisions,
  setsEqual,
  isSubset,
  BASELINE,
};

if (require.main === module) main();
