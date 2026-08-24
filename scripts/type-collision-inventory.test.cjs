#!/usr/bin/env node
/**
 * Counterprobe for scripts/type-collision-inventory.cjs.
 *
 * Same reasoning as authz-boundary.test.cjs: a check nobody has watched fail
 * is not a check. This plants real `export type` declarations -- never edits
 * a constant inside the checker -- and proves both directions: a genuine new
 * collision is rejected, and shapes that must NOT count (a pure alias, an
 * unresolved type, a type that merely shares a file with a real collision)
 * are accepted. Probes run inside a private sandbox copy of frontend/src and
 * backend/src (NIL-493's reasoning in sandbox-tree.cjs applies here exactly
 * as it does to the other two boundary checks).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const { ROOTS } = require("./type-collision-inventory.cjs");

const root = createSandbox(
  repoRoot,
  [...ROOTS.map((r) => path.relative(repoRoot, r).split(path.sep).join("/")), "scripts"],
  "type-collision-inventory-sandbox-",
);
const CHECK = path.join(root, "scripts", "type-collision-inventory.cjs");
const FRONTEND_PROBE_DIR = path.join(root, "frontend", "src", "__type_collision_probe__");
const BACKEND_PROBE_DIR = path.join(root, "backend", "src", "__type_collision_probe__");

const run = (script = CHECK) =>
  spawnSync("node", [script], { cwd: root, encoding: "utf8" });

const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

/** Plant one or more probe files, run the check, clean up -- even on failure. */
const withProbeFiles = (files, callback) => {
  for (const dir of [FRONTEND_PROBE_DIR, BACKEND_PROBE_DIR]) {
    if (fs.existsSync(dir)) {
      throw new Error(`Refusing to reuse an existing probe directory: ${dir}`);
    }
  }
  try {
    for (const [absPath, contents] of files) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, contents, "utf8");
    }
    return callback();
  } finally {
    for (const dir of [FRONTEND_PROBE_DIR, BACKEND_PROBE_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
};

const assertRejectsWith = (label, files, needles) => {
  withProbeFiles(files, () => {
    const result = run();
    const output = outputOf(result);
    const missing = needles.filter((needle) => !output.includes(needle));
    if (result.status === 1 && missing.length === 0) {
      console.log(`  red on ${label}`);
      return;
    }
    throw new Error(
      `${label} was NOT rejected as expected.\nexpected exit 1 mentioning ${JSON.stringify(needles)}\n` +
        `got exit ${result.status}\n${output}`,
    );
  });
};

const assertAccepts = (label, files) => {
  withProbeFiles(files, () => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 0) {
      console.log(`  green on ${label}`);
      return;
    }
    throw new Error(`${label} was wrongly rejected -- the resolver is too wide.\n${output}`);
  });
};

const frontendFile = (name) => path.join(FRONTEND_PROBE_DIR, name);
const backendFile = (name) => path.join(BACKEND_PROBE_DIR, name);

const rejected = [
  [
    "two independently-declared unions built from the same literals",
    [
      [frontendFile("probeFront.ts"), 'export type ProbeFrontKind = "alpha" | "beta" | "gamma";\n'],
      [backendFile("probeBack.ts"), 'export type ProbeBackKind = "alpha" | "beta" | "gamma";\n'],
    ],
    ["NEW COLLISION", "ProbeFrontKind", "ProbeBackKind", "identical"],
  ],
  [
    "one union structurally a subset of another",
    [
      [frontendFile("probeNarrow.ts"), 'export type ProbeNarrowKind = "alpha" | "beta";\n'],
      [
        backendFile("probeWide.ts"),
        'export type ProbeWideKind = "alpha" | "beta" | "gamma" | "delta";\n',
      ],
    ],
    ["NEW COLLISION", "ProbeNarrowKind", "ProbeWideKind", "⊆"],
  ],
  [
    "the collision reached through an import, not a literal in the same file",
    [
      [frontendFile("probeImportedBase.ts"), 'export type ProbeImportedBase = "x" | "y";\n'],
      [
        frontendFile("probeImportedUser.ts"),
        'import type { ProbeImportedBase } from "./probeImportedBase";\n' +
          'export type ProbeCombined = ProbeImportedBase | "z";\n',
      ],
      [backendFile("probeImportedMatch.ts"), 'export type ProbeImportedMatch = "x" | "y" | "z";\n'],
    ],
    ["NEW COLLISION", "ProbeCombined", "ProbeImportedMatch", "identical"],
  ],
];

const accepted = [
  [
    "a declaration this resolver cannot parse (object type)",
    [[frontendFile("probeObject.ts"), 'export type ProbeObjectShape = { kind: "alpha" | "beta" };\n']],
  ],
  [
    "a generic type alias",
    [[frontendFile("probeGeneric.ts"), 'export type ProbeGeneric<T> = "alpha" | T;\n']],
  ],
  [
    "a self-referential union (cycle guard)",
    [
      [
        frontendFile("probeCycleA.ts"),
        'import type { ProbeCycleB } from "./probeCycleB";\n' +
          'export type ProbeCycleA = ProbeCycleB | "a";\n',
      ],
      [
        frontendFile("probeCycleB.ts"),
        'import type { ProbeCycleA } from "./probeCycleA";\n' +
          'export type ProbeCycleB = ProbeCycleA | "b";\n',
      ],
    ],
  ],
];

/**
 * A pure re-export alias (`export type A = B;`) of a type that DOES collide
 * with something else must not be reported as a second, independent
 * collision of its own -- it is the same declaration by reference, not a
 * second one that could drift. The underlying collision (base/match) must
 * still be caught; only the alias's own name must never appear.
 */
const assertAliasNotFlaggedAsThirdCollision = () => {
  const files = [
    [frontendFile("probeAliasBase.ts"), 'export type ProbeAliasBase = "one" | "two";\n'],
    [backendFile("probeAliasMatch.ts"), 'export type ProbeAliasMatch = "one" | "two";\n'],
    [
      frontendFile("probeAliasReexport.ts"),
      'import type { ProbeAliasBase } from "./probeAliasBase";\n' +
        "export type ProbeAliasReexport = ProbeAliasBase;\n",
    ],
  ];
  withProbeFiles(files, () => {
    const result = run();
    const output = outputOf(result);
    const caughtUnderlying =
      result.status === 1 &&
      output.includes("ProbeAliasBase") &&
      output.includes("ProbeAliasMatch") &&
      output.includes("identical");
    if (!caughtUnderlying) {
      throw new Error(`Expected the underlying ProbeAliasBase/ProbeAliasMatch collision.\n${output}`);
    }
    if (output.includes("ProbeAliasReexport")) {
      throw new Error(`The alias was wrongly flagged as its own collision.\n${output}`);
    }
    console.log("  a pure alias of a colliding type is not itself flagged");
  });
};

const assertStaleBaselineCaught = () => {
  const patched = path.join(root, "scripts", ".type-collision-inventory.stale-probe.cjs");
  const source = fs.readFileSync(CHECK, "utf8");
  const marker = "const BASELINE = [";
  if (!source.includes(marker)) {
    throw new Error("Stale probe anchor missing; type-collision-inventory.cjs changed shape.");
  }
  const bogusKey = "NonexistentTypeOne / NonexistentTypeTwo";
  const injected = `${marker}\n  { key: ${JSON.stringify(bogusKey)}, reason: "probe" },`;
  fs.writeFileSync(patched, source.replace(marker, injected), "utf8");
  try {
    const result = run(patched);
    const output = outputOf(result);
    if (result.status === 1 && output.includes("STALE") && output.includes(bogusKey)) {
      console.log(`  red on stale baseline entry: ${bogusKey}`);
      return;
    }
    throw new Error(`A stale baseline entry was NOT reported.\nexit ${result.status}\n${output}`);
  } finally {
    fs.rmSync(patched, { force: true });
  }
};

const main = () => {
  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`The tree should pass before probing.\n${outputOf(clean)}`);
  }
  console.log("  green on the unmodified tree");

  for (const [label, files, needles] of rejected) assertRejectsWith(label, files, needles);
  for (const [label, files] of accepted) assertAccepts(label, files);
  assertAliasNotFlaggedAsThirdCollision();
  assertStaleBaselineCaught();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Type-collision inventory proved in both directions.");
};

try {
  main();
} finally {
  removeSandbox(root);
}
