#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const root = createSandbox(
  repoRoot,
  ["packages/domain/src", "frontend/src", "backend/src", "scripts/domain-boundary.cjs"],
  "domain-boundary-sandbox-",
);
const check = path.join(root, "scripts", "domain-boundary.cjs");
const run = () =>
  spawnSync("node", [check], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: [path.join(repoRoot, "node_modules"), process.env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
const output = (result) => `${result.stdout || ""}${result.stderr || ""}`;
const installRenamedShapeProbe = ({ fixture, domainName, applicationName }) => {
  const source = path.join(repoRoot, "scripts", "test-fixtures", fixture);
  const domainCopy = path.join(root, "packages", "domain", "src", "__shape_probe__", fixture);
  const applicationCopy = path.join(root, "frontend", "src", "__domain_probe__", fixture);
  fs.mkdirSync(path.dirname(domainCopy), { recursive: true });
  fs.mkdirSync(path.dirname(applicationCopy), { recursive: true });
  fs.copyFileSync(source, domainCopy);
  fs.copyFileSync(source, applicationCopy);
  fs.writeFileSync(
    applicationCopy,
    fs.readFileSync(applicationCopy, "utf8").replace(domainName, applicationName),
    "utf8",
  );
  return applicationCopy;
};

const removeProbeDirectories = (...directories) => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
};

try {
  assert.equal(run().status, 0, "the real migrated tree must be clean before probing");

  // The acceptance counterproof is deliberately a file copy: a shared schema
  // copied back into an application must make the check red without changing
  // or checking out any real worktree file.
  const copiedContract = path.join(root, "frontend", "src", "__domain_probe__", "customData.ts");
  fs.mkdirSync(path.dirname(copiedContract), { recursive: true });
  fs.copyFileSync(
    path.join(root, "packages", "domain", "src", "excalidraw", "customData.ts"),
    copiedContract,
  );
  const duplicate = run();
  assert.equal(duplicate.status, 1, "a copied domain contract must turn the guard red");
  assert.match(output(duplicate), /__domain_probe__\/customData\.ts/);
  fs.rmSync(path.dirname(copiedContract), { recursive: true, force: true });

  const renamedObject = installRenamedShapeProbe({
    fixture: "domain-boundary-small-object.ts",
    domainName: "SharedCoordinate",
    applicationName: "LocalPoint",
  });
  const objectResult = run();
  assert.equal(objectResult.status, 1, "a renamed small object duplicate must turn the guard red");
  assert.match(output(objectResult), /DUPLICATE SHAPE\s+SharedCoordinate .* <> LocalPoint /);
  fs.rmSync(path.dirname(renamedObject), { recursive: true, force: true });
  fs.rmSync(path.join(root, "packages", "domain", "src", "__shape_probe__"), {
    recursive: true,
    force: true,
  });

  const interfaceSource = path.join(
    repoRoot,
    "scripts",
    "test-fixtures",
    "domain-boundary-interface-object.ts",
  );
  const domainType = path.join(
    root,
    "packages",
    "domain",
    "src",
    "__interface_probe__",
    "coordinate.ts",
  );
  const applicationInterface = path.join(
    root,
    "frontend",
    "src",
    "__interface_probe__",
    "point.ts",
  );
  fs.mkdirSync(path.dirname(domainType), { recursive: true });
  fs.mkdirSync(path.dirname(applicationInterface), { recursive: true });
  fs.copyFileSync(interfaceSource, domainType);
  fs.copyFileSync(interfaceSource, applicationInterface);
  fs.writeFileSync(
    applicationInterface,
    fs
      .readFileSync(applicationInterface, "utf8")
      .replace(
        "export type SharedProbeCoordinate = { probeX: number; probeY: string };",
        "export interface LocalProbePoint { probeX: number; probeY: string }",
      ),
    "utf8",
  );
  const interfaceResult = run();
  assert.equal(
    interfaceResult.status,
    1,
    "a renamed interface copy of a domain type must turn the guard red",
  );
  assert.match(
    output(interfaceResult),
    /DUPLICATE SHAPE\s+SharedProbeCoordinate .* <> LocalProbePoint /,
  );
  removeProbeDirectories(path.dirname(domainType), path.dirname(applicationInterface));

  const functionSource = path.join(
    repoRoot,
    "scripts",
    "test-fixtures",
    "domain-boundary-pure-function.ts",
  );
  const frontendFunction = path.join(
    root,
    "frontend",
    "src",
    "__function_probe__",
    "pagination.ts",
  );
  const backendFunction = path.join(root, "backend", "src", "__function_probe__", "pagination.ts");
  fs.mkdirSync(path.dirname(frontendFunction), { recursive: true });
  fs.mkdirSync(path.dirname(backendFunction), { recursive: true });
  fs.copyFileSync(functionSource, frontendFunction);
  fs.copyFileSync(functionSource, backendFunction);
  fs.writeFileSync(
    backendFunction,
    fs.readFileSync(backendFunction, "utf8").replace("sharedPageCount", "serverPageCount"),
    "utf8",
  );
  const functionResult = run();
  assert.equal(
    functionResult.status,
    1,
    "a pure function duplicated between frontend and backend must turn the guard red",
  );
  assert.match(output(functionResult), /DUPLICATE SHAPE\s+sharedPageCount .* <> serverPageCount /);
  removeProbeDirectories(path.dirname(frontendFunction), path.dirname(backendFunction));

  const renamedUnion = installRenamedShapeProbe({
    fixture: "domain-boundary-small-union.ts",
    domainName: "SharedOutcome",
    applicationName: "LocalResult",
  });
  const unionResult = run();
  assert.equal(unionResult.status, 1, "a renamed two-branch union must turn the guard red");
  assert.match(output(unionResult), /DUPLICATE SHAPE\s+SharedOutcome .* <> LocalResult /);
  fs.rmSync(path.dirname(renamedUnion), { recursive: true, force: true });
  fs.rmSync(path.join(root, "packages", "domain", "src", "__shape_probe__"), {
    recursive: true,
    force: true,
  });

  const inward = path.join(root, "packages", "domain", "src", "documents", "__inward.ts");
  fs.writeFileSync(inward, 'import "../../../frontend/src/api";\n', "utf8");
  const inwardResult = run();
  assert.equal(inwardResult.status, 1, "an inward application import must turn the guard red");
  assert.match(output(inwardResult), /INWARD IMPORT/);

  console.log(
    "Domain boundary counterprobes passed (same-name copy; renamed small object, union, and interface; pure cross-application function; and inward import red).",
  );
} finally {
  removeSandbox(root);
}
