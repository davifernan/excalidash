#!/usr/bin/env node
/**
 * Counterprobe for scripts/agent-token-boundary.cjs (NIL-382/NIL-503).
 *
 * Same discipline as authz-boundary.test.cjs: the check is only worth its
 * green when it has been watched go red. Each probe plants one real
 * violation of one rule, in a private sandbox copy of the tree (never the
 * real one, never git checkout --), and requires the check to name what it
 * planted. The negative probes matter as much as the positive ones -- a rule
 * wide enough to flag a legitimate `where: { id }` lookup or a route the
 * middleware genuinely covers would go red on correct code.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const { SRC: REAL_SRC, RESOLVER_FILE, AUTH_MIDDLEWARE_FILE } = require("./agent-token-boundary.cjs");

const root = createSandbox(
  repoRoot,
  [path.relative(repoRoot, REAL_SRC).split(path.sep).join("/"), "scripts/agent-token-boundary.cjs"],
  "agent-token-boundary-sandbox-",
);
const CHECK = path.join(root, "scripts", "agent-token-boundary.cjs");
const PROBE_DIR = path.join(root, "backend", "src", "__agent_token_probe__");

const run = () =>
  spawnSync("node", [CHECK], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } });

const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

const withProbeFile = (relativePathUnderSrc, contents, callback) => {
  const file = path.join(root, "backend", "src", relativePathUnderSrc);
  if (fs.existsSync(file)) {
    throw new Error(`Refusing to overwrite an existing file: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  try {
    return callback(path.relative(root, file).split(path.sep).join("/"));
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

const assertRejects = (label, relativePathUnderSrc, contents) => {
  withProbeFile(relativePathUnderSrc, contents, (relative) => {
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

const assertAccepts = (label, relativePathUnderSrc, contents) => {
  withProbeFile(relativePathUnderSrc, contents, () => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 0) {
      console.log(`  green on ${label}`);
      return;
    }
    throw new Error(
      `${label} was wrongly rejected -- the rule is too wide.\nexit ${result.status}\n${output}`,
    );
  });
};

/** Mutate a file inside the sandbox, run the check, then restore it. */
const withMutatedFile = (relativeToRoot, mutate, callback) => {
  const file = path.join(root, relativeToRoot);
  const original = fs.readFileSync(file, "utf8");
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(`Probe mutation for ${relativeToRoot} did not change anything -- target text not found.`);
  }
  fs.writeFileSync(file, mutated, "utf8");
  try {
    return callback();
  } finally {
    fs.writeFileSync(file, original, "utf8");
  }
};

const rejected = [
  [
    "a second bearer-token lookup by keyId, outside the resolver",
    "__agent_token_probe__/secondAuthPath.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, keyId: string) =>\n" +
      "  prisma.apiKey.findUnique({ where: { keyId } });\n",
  ],
  [
    "the same shape via findFirst",
    "__agent_token_probe__/secondAuthPathFindFirst.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, keyId: string) =>\n" +
      "  prisma.apiKey.findFirst({ where: { keyId, revokedAt: null } });\n",
  ],
  [
    "a new agent route the recognizer does not know",
    // Registered under routes/ so findRegisteredAgentRoutes's directory walk
    // picks it up, same as a real route file would be.
    "routes/__agent_token_probe_route__.ts",
    "export const probe = (app: any) => {\n" +
      '  app.get("/drawings/:id/agent/rename", (req: any, res: any) => res.json({}));\n' +
      "};\n",
  ],
];

const accepted = [
  [
    "revocation lookup by primary key id",
    "__agent_token_probe__/revokeById.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, id: string) =>\n" +
      "  prisma.apiKey.findUnique({ where: { id } });\n",
  ],
  [
    "listing an account's own keys by userId",
    "__agent_token_probe__/listByUserId.ts",
    'import type { PrismaClient } from "../generated/client";\n' +
      "export const probe = (prisma: PrismaClient, userId: string) =>\n" +
      "  prisma.apiKey.findMany({ where: { userId } });\n",
  ],
  [
    "a route with 'keyId' as an unrelated local variable name, not a where-filter",
    "__agent_token_probe__/unrelatedKeyId.ts",
    "export const probe = (keyId: string) => {\n" +
      "  const label = `key ${keyId}`;\n" +
      "  return label;\n" +
      "};\n",
  ],
];

const assertKnownRouteRemovalCaught = () => {
  const label = "the recognizer forgets a route that is still registered (removing a recognized line)";
  withMutatedFile(
    AUTH_MIDDLEWARE_FILE,
    (source) =>
      source.replace(
        'if (action === "ops" && method === "POST") return { drawingId, scope: DRAWING_OPS_SCOPE };\n',
        "",
      ),
    () => {
      const result = run();
      const output = outputOf(result);
      if (
        result.status === 1 &&
        output.includes("POST .../agent/ops") &&
        output.includes("does not recognize it")
      ) {
        console.log(`  red on ${label}`);
        return;
      }
      throw new Error(`${label} was NOT rejected.\nexit ${result.status}\n${output}`);
    },
  );
};

const assertStaleRecognizedCaught = () => {
  const label = "the recognizer keeps a route nothing registers anymore (stale entry)";
  withMutatedFile(
    AUTH_MIDDLEWARE_FILE,
    (source) =>
      source.replace(
        'if (action === "ops" && method === "POST") return { drawingId, scope: DRAWING_OPS_SCOPE };',
        'if (action === "ops" && method === "POST") return { drawingId, scope: DRAWING_OPS_SCOPE };\n' +
          '  if (action === "long-since-removed" && method === "DELETE") return { drawingId, scope: DRAWING_OPS_SCOPE };',
      ),
    () => {
      const result = run();
      const output = outputOf(result);
      if (
        result.status === 1 &&
        output.includes("DELETE .../agent/long-since-removed") &&
        output.includes("no route registers it")
      ) {
        console.log(`  red on ${label}`);
        return;
      }
      throw new Error(`${label} was NOT rejected.\nexit ${result.status}\n${output}`);
    },
  );
};

const main = () => {
  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`The tree should pass before probing.\n${outputOf(clean)}`);
  }
  console.log("  green on the unmodified tree");
  console.log(`  resolver is ${RESOLVER_FILE}`);

  for (const [label, name, contents] of rejected) assertRejects(label, name, contents);
  for (const [label, name, contents] of accepted) assertAccepts(label, name, contents);
  assertKnownRouteRemovalCaught();
  assertStaleRecognizedCaught();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Agent token boundary check proved in both directions.");
};

try {
  main();
} finally {
  removeSandbox(root);
}
