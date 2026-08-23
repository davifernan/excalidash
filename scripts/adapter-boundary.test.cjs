#!/usr/bin/env node
/**
 * Counterprobe for scripts/adapter-boundary.cjs.
 *
 * The check is only worth its green when it has been watched to go red. Each
 * probe below plants one real violation of one rule and requires the check to
 * name the file it planted. The clean tree is asserted first, so a check that
 * rejects everything cannot pass this either.
 *
 * The probes break the ENFORCEMENT -- an import, a selector, a synthesised
 * event, a direct write -- not a threshold or a constant.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const CHECK = path.join(root, "scripts", "adapter-boundary.cjs");
const PROBE_DIR = path.join(root, "frontend", "src", "__adapter_probe__");

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
      console.log(`  red on ${label}: ${relative}`);
      return;
    }
    throw new Error(
      `${label} was NOT rejected.\nexpected exit 1 naming ${relative}\n` +
        `got exit ${result.status}\n${output}`,
    );
  });
};

const probes = [
  [
    "static package import",
    "staticImport.ts",
    'import { exportToSvg } from "@excalidraw/excalidraw";\nexport const probe = exportToSvg;\n',
  ],
  [
    // The one a naive `from "@excalidraw"` grep misses. useDrawingPreview.ts
    // reaches the package exactly this way and was missed exactly this way.
    "dynamic package import",
    "dynamicImport.ts",
    'export const probe = async () => (await import("@excalidraw/excalidraw")).exportToSvg;\n',
  ],
  [
    "internal DOM selector",
    "domSelector.ts",
    'export const probe = (el: HTMLElement) => el.querySelector(".App-toolbar");\n',
  ],
  [
    "synthetic keyboard event",
    "syntheticEvent.ts",
    'export const probe = (el: HTMLElement) =>\n  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));\n',
  ],
  [
    "direct customData write",
    "customDataWrite.ts",
    "export const probe = (element: { customData?: unknown }) => ({\n  ...element,\n  customData: { excalidash: { schemaVersion: 2 } },\n});\n",
  ],
];

const assertStaleExceptionCaught = () => {
  const patched = path.join(root, "scripts", ".adapter-boundary.stale-probe.cjs");
  const source = fs.readFileSync(CHECK, "utf8");
  const marker = '  "frontend/src/utils/importHelpers.ts",\n]);';
  if (!source.includes(marker)) {
    throw new Error("Stale probe anchor missing; adapter-boundary.cjs changed shape.");
  }
  const bogus = "frontend/src/utils/never-imported-excalidraw.ts";
  fs.writeFileSync(
    patched,
    source.replace(marker, `  "frontend/src/utils/importHelpers.ts",\n  "${bogus}",\n]);`),
    "utf8",
  );
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

/**
 * The retired customData key, planted where the migration missed it three times.
 *
 * Not under frontend/src: the point of this rule is that the stored shape is
 * read outside the product code too, and the two places that were missed were
 * the backend and the E2E helpers.
 */
const assertLegacyKeyCaught = () => {
  const file = path.join(root, "e2e", "tests", "__legacy_probe.spec.ts");
  if (fs.existsSync(file)) {
    throw new Error(`Refusing to overwrite an existing probe path: ${file}`);
  }
  fs.writeFileSync(
    file,
    "export const probe = (element: any) => element.customData?.excalidashSticky;\n",
    "utf8",
  );
  try {
    const result = run();
    const output = outputOf(result);
    if (result.status === 1 && output.includes("LEGACY") && output.includes("excalidashSticky")) {
      console.log("  red on retired customData key outside frontend/src");
      return;
    }
    throw new Error(`A retired key was NOT reported.\nexit ${result.status}\n${output}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
};

const main = () => {
  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`The tree should pass before probing.\n${outputOf(clean)}`);
  }
  console.log("  green on the unmodified tree");

  for (const [label, name, contents] of probes) assertRejects(label, name, contents);
  assertStaleExceptionCaught();
  assertLegacyKeyCaught();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Adapter boundary check proved in both directions.");
};

main();
