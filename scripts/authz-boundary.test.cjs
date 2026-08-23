#!/usr/bin/env node
/**
 * Counterprobe for scripts/authz-boundary.cjs.
 *
 * The check is only worth its green when it has been watched to go red. Each
 * probe below plants one real violation of one rule and requires the check to
 * name the file it planted.
 *
 * The probes break the ENFORCEMENT -- a table read, a where-clause, a level
 * rebuilt from strings -- never a constant inside the check. Breaking a
 * constant proves the probe works, not that the rule does.
 *
 * The negative probes matter just as much. A rule wide enough to flag a
 * create, an account-owned table or a normalized level would go red on correct
 * code, and a check that cries wolf trains people to walk past red exactly as
 * surely as one that stays green over a hole. Every ACCEPT below is a shape
 * that was measured in this backend and must stay legal.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const CHECK = path.join(root, "scripts", "authz-boundary.cjs");
const PROBE_DIR = path.join(root, "backend", "src", "__authz_probe__");

const run = (script = CHECK) =>
  spawnSync("node", [script], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } });

const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

const withProbeFile = (name, contents, callback) => {
  const file = path.join(PROBE_DIR, name);
  if (fs.existsSync(PROBE_DIR)) {
    throw new Error(`Refusing to reuse an existing probe directory: ${PROBE_DIR}`);
  }
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  try {
    fs.writeFileSync(file, contents, "utf8");
    return callback(path.relative(root, file).split(path.sep).join("/"));
  } finally {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

const assertRejects = (label, name, contents) => {
  withProbeFile(name, contents, (relative) => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 1 && output.includes(relative)) {
      console.log(`  red on ${label}`);
      return;
    }
    throw new Error(
      `${label} was NOT rejected.\nexpected exit 1 naming ${relative}\n` +
        `got exit ${result.status}\n${output}`,
    );
  });
};

const assertAccepts = (label, name, contents) => {
  withProbeFile(name, contents, (relative) => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 0) {
      console.log(`  green on ${label}`);
      return;
    }
    throw new Error(
      `${label} was wrongly rejected -- the rule is too wide.\n` +
        `${relative}\nexit ${result.status}\n${output}`,
    );
  });
};

const rejected = [
  [
    "grant table through the prisma client",
    "grantTable.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, drawingId: string) =>\n" +
      "  prisma.drawingPermission.findMany({ where: { drawingId } });\n",
  ],
  [
    // The five call sites the ticket's own inventory missed. auth/userOffboarding.ts
    // touches the grant tables ONLY this way, so a rule anchored on `prisma.`
    // reports green over that entire file.
    "grant table through the transaction client",
    "grantTableTx.ts",
    'import type { Prisma } from "../generated/client";\n' +
      "export const probe = (tx: Prisma.TransactionClient, collectionId: string) =>\n" +
      "  tx.collectionShare.deleteMany({ where: { collectionId } });\n",
  ],
  [
    // The shape that walked past the adapter check's first version.
    "grant table through optional chaining",
    "grantTableOptional.ts",
    "export const probe = (db: any, drawingId: string) =>\n" +
      "  db?.drawingLinkShare?.findMany({ where: { drawingId } });\n",
  ],
  [
    "grant table through an index expression",
    "grantTableIndex.ts",
    'export const probe = (db: any) => db["collectionShare"].findMany({});\n',
  ],
  [
    "board ownership decided by a where-clause",
    "ownershipFilter.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) =>\n" +
      "  prisma.drawing.findMany({ where: { userId } });\n",
  ],
  [
    // exportRoutes filtered snapshots and drawing-assets exactly this way: the
    // same ownership rule, one relation hop from the model that owns it.
    "board ownership decided one relation away",
    "ownershipRelation.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) =>\n" +
      "  prisma.drawingSnapshot.findMany({ where: { drawing: { userId } } });\n",
  ],
  [
    "a permission level rebuilt from a literal set",
    "levelSet.ts",
    'export const probe = (role: string) => ["view", "edit"].includes(role);\n',
  ],
  [
    "a raw grant field compared to a level",
    "levelCompare.ts",
    'export const probe = (share: { role: string }) => share.role === "edit";\n',
  ],
  [
    "ownership decided from a board row's userId",
    "ownerCompare.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = async (prisma: PrismaClient, id: string, me: string) => {\n" +
      "  const existing = await prisma.drawing.findUnique({ where: { id } });\n" +
      "  return existing!.userId !== me;\n" +
      "};\n",
  ],
  [
    // Written the other way round. drawingReadRoutes.ts had
    // `principal.userId === drawing.userId`, and the first version of this rule
    // -- anchored on "field, then operator" -- read straight past it.
    "ownership decided with the comparison reversed",
    "ownerCompareReversed.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = async (prisma: PrismaClient, id: string, me: string) => {\n" +
      "  const board = await prisma.drawing.findFirst({ where: { id } });\n" +
      "  return me === board!.userId;\n" +
      "};\n",
  ],
  [
    // Found by review, not by this file. The rule was anchored on `where:`
    // followed immediately by `{`, so a where-clause declared as a variable was
    // invisible -- and the core "list my boards" query was written exactly that
    // way, unmigrated, while the check reported zero exceptions.
    "a board ownership filter declared as a variable",
    "declaredWhere.ts",
    'import type { Prisma, PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) => {\n" +
      "  const where: Prisma.DrawingWhereInput = { userId };\n" +
      "  return prisma.drawing.findMany({ where });\n" +
      "};\n",
  ],
  [
    // The negated half of "shared with me" is the same column deciding the same
    // thing, and it sat in the same missed declaration.
    "a board ownership filter declared with a negation",
    "declaredWhereNegated.ts",
    'import type { Prisma } from "../generated/client";\n' +
      "export const probe = (userId: string) => {\n" +
      "  const whereDrawing: Prisma.DrawingWhereInput = { userId: { not: userId } };\n" +
      "  return whereDrawing;\n" +
      "};\n",
  ],
  [
    // Reaching DrawingPermission without ever naming it. The check listed the
    // model names and not the relation fields, which is the adapter check's
    // original mistake made again one layer down.
    "a grant table read through its relation field",
    "grantRelation.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) =>\n" +
      "  prisma.drawing.findMany({\n" +
      "    where: { permissions: { some: { granteeUserId: userId } } },\n" +
      "  });\n",
  ],
  [
    "a grant table read through a relation select",
    "grantRelationSelect.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) =>\n" +
      "  prisma.drawing.findMany({\n" +
      "    select: { permissions: { where: { granteeUserId: userId }, select: { permission: true } } },\n" +
      "  });\n",
  ],
];

/**
 * Shapes that must stay legal.
 *
 * Each was measured in this backend. If one of them ever goes red, the rule has
 * stopped separating an authorization decision from the three things that look
 * like one.
 */
const accepted = [
  [
    "assigning ownership on create",
    "createAssign.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string, name: string) =>\n" +
      "  prisma.collection.create({ data: { name, userId } });\n",
  ],
  [
    // drawingRouteContext.ts scopes S3 cleanup this way. `S3File.userId` is a
    // storage path key -- drawingS3Prefix(userId, drawingId) -- not an ACL.
    "an account-owned table filtered by userId",
    "accountOwned.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string, drawingId: string) =>\n" +
      "  prisma.s3File.findMany({ where: { drawingId, userId } });\n",
  ],
  [
    "an account's own record looked up by id",
    "accountSelf.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, id: string) =>\n" +
      "  prisma.user.findUnique({ where: { id }, select: { isActive: true } });\n",
  ],
  [
    // drawingSharingRoutes picks a link TTL this way, on a value that already
    // came out of normalizeDrawingPermission. Policy keyed on a level is not
    // a level rebuilt from strings.
    "branching on an already normalized level",
    "normalizedBranch.ts",
    'import { normalizeDrawingPermission } from "../authz/sharing";\n' +
      "export const probe = (raw: unknown) => {\n" +
      "  const permission = normalizeDrawingPermission(raw);\n" +
      '  return permission === "edit" ? 1 : 2;\n' +
      "};\n",
  ],
  [
    // drawingCreateUpdateRoutes builds `updateWhere: Prisma.DrawingWhereInput =
    // { id }`. A rule that flagged the annotation instead of the userId key
    // would redden it, and filtering a board by its own id decides nothing.
    "a where variable that carries no ownership claim",
    "declaredWhereById.ts",
    'import type { Prisma } from "../generated/client";\n' +
      "export const probe = (id: string) => {\n" +
      "  const updateWhere: Prisma.DrawingWhereInput = { id };\n" +
      "  return updateWhere;\n" +
      "};\n",
  ],
  [
    // After migration the route still names the field; the contract builds the
    // shape. `permissions: grantedLevelSelect(userId)` is the boundary working,
    // not a hole in it.
    "a grant relation whose shape comes from the contract",
    "grantRelationViaContract.ts",
    'import { grantedLevelSelect } from "../authz/boards";\n' +
      "export const probe = (userId: string) => ({\n" +
      "  permissions: grantedLevelSelect(userId),\n" +
      "});\n",
  ],
  [
    // Nine `.userId ===` comparisons in this backend are about a JWT payload, a
    // stored refresh token, a socket principal or a roster member. A rule that
    // matched the field name would flag every one of them.
    "a token payload compared by userId",
    "tokenPayload.ts",
    "export const probe = (payload: { userId: string }, storedUserId: string) =>\n" +
      "  payload.userId === storedUserId;\n",
  ],
];

/**
 * A migrated file that keeps its licence to misbehave quietly widens the hole
 * again the next time somebody edits it.
 */
const assertStaleExceptionCaught = () => {
  const patched = path.join(root, "scripts", ".authz-boundary.stale-probe.cjs");
  const source = fs.readFileSync(CHECK, "utf8");
  // Anchored on the structure rather than on a member, because the lists are
  // empty and a member anchor would have nothing to match.
  const marker = "const GRANT_TABLE_EXCEPTIONS = new Set([";
  if (!source.includes(marker)) {
    throw new Error("Stale probe anchor missing; authz-boundary.cjs changed shape.");
  }
  const bogus = "backend/src/config.ts";
  fs.writeFileSync(patched, source.replace(marker, `${marker}\n  "${bogus}",`), "utf8");
  try {
    const result = run(patched);
    const output = outputOf(result);
    if (result.status === 1 && output.includes("STALE") && output.includes(bogus)) {
      console.log(`  red on stale exception: ${bogus}`);
      return;
    }
    throw new Error(`A stale exception was NOT reported.\nexit ${result.status}\n${output}`);
  } finally {
    fs.rmSync(patched, { force: true });
  }
};

const assertNoExceptionsRemain = () => {
  const { RULES } = require("./authz-boundary.cjs");
  const listed = RULES.flatMap((rule) => [...rule.exceptions].map((f) => `${rule.id}: ${f}`));
  if (listed.length > 0) {
    throw new Error(
      "The authz boundary has exceptions again:\n  " +
        listed.join("\n  ") +
        "\nGrow the contract in backend/src/authz/ instead of reaching past it, or argue " +
        "the exception on NIL-487 and change this probe deliberately.",
    );
  }

  // The assertion above only means something if it fails on a populated list.
  // Without this, an empty-by-construction check would pass it forever -- which
  // is exactly the always-green test this repository has shipped before.
  const populated = [{ id: "grant-table-access", exceptions: new Set(["backend/src/x.ts"]) }];
  const wouldList = populated.flatMap((rule) => [...rule.exceptions].map((f) => `${rule.id}: ${f}`));
  if (wouldList.length === 0) {
    throw new Error("The empty-list probe cannot tell an exception from none.");
  }
  console.log("  no rule carries an exception, and the probe still sees one when it is there");
};

const main = () => {
  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`The tree should pass before probing.\n${outputOf(clean)}`);
  }
  console.log("  green on the unmodified tree");

  for (const [label, name, contents] of rejected) assertRejects(label, name, contents);
  for (const [label, name, contents] of accepted) assertAccepts(label, name, contents);
  assertStaleExceptionCaught();
  assertNoExceptionsRemain();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Authz boundary check proved in both directions.");
};

main();
