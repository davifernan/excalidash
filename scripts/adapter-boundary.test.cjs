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

/**
 * The counterpart to assertRejects: a file that LOOKS like the pattern this
 * rule matches on, but goes through the capability layer correctly, must not
 * be named as a violation. Without this direction, a fix that makes the
 * pattern stricter (NIL-324's receiver-name exclusion) has no probe proving
 * it did not just start missing the real thing too -- assertRejects above
 * already covers that half, on the same rule, in the same run.
 */
const assertAccepted = (label, name, contents) => {
  withProbeFile(name, contents, (relative) => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 0 && !output.includes(relative)) {
      console.log(`  green on ${label}: ${relative}`);
      return;
    }
    throw new Error(
      `${label} was rejected when it should not have been.\nexpected exit 0, ${relative} absent\n` +
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
    // Re-export reaches the package as surely as import, and the first version
    // of the rule saw only `import`.
    "package re-export",
    "reExport.ts",
    'export { exportToSvg } from "@excalidraw/excalidraw";\n',
  ],
  [
    // An assignment is a write. Only the object-literal form was matched.
    "customData assignment",
    "customDataAssign.ts",
    "export const probe = (element: { customData?: unknown }) => {\n  element.customData = { excalidash: {} };\n};\n",
  ],
  [
    // The interactive canvas, which domBridge.ts lists as an internal selector
    // and which the word-boundary pattern did not match.
    "interactive canvas selector",
    "interactiveCanvas.ts",
    'export const probe = (el: HTMLElement) =>\n  el.querySelector("canvas.excalidraw__canvas.interactive");\n',
  ],
  [
    // The largest half of the seam: a consumer does not have to name the
    // package to depend on it -- the handle is passed in.
    "raw imperative API call",
    "rawApiCall.ts",
    "export const probe = (api: { getAppState: () => unknown }) => api.getAppState();\n",
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
  // Anchored on the structure, not on a particular entry. The list shrinks as
  // consumers migrate, and an anchor that is one of its members stops matching
  // the moment that file is done -- which it did, loudly, on the first batch.
  const marker = "const PACKAGE_IMPORT_EXCEPTIONS = new Set([";
  if (!source.includes(marker)) {
    throw new Error("Stale probe anchor missing; adapter-boundary.cjs changed shape.");
  }
  const bogus = "frontend/src/utils/never-imported-excalidraw.ts";
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

/**
 * The lists are empty, and this is what keeps them that way.
 *
 * An exception is a legitimate tool while a migration runs -- all five rules
 * were closed by shrinking a named list to nothing, one file at a time. Once a
 * list is empty, a new entry is no longer a step in that work: it is a bypass,
 * and it arrives inside a diff that otherwise looks like ordinary feature work.
 *
 * So the empty state is asserted, not merely printed at the end of a run. A name
 * coming back turns this test red, and the change has to be argued for instead
 * of slipped in. Deleting this probe is itself the decision to allow bypasses.
 */
/**
 * NIL-324: `interaction.onPointerDown(...)` used to match the raw-API-call
 * pattern exactly as readily as a real raw call, because the pattern had no
 * receiver awareness at all. Every CAPABILITY_RECEIVER_NAMES entry is proved
 * here in one probe file -- one bare call per capability, the exact call
 * shape a consumer writes -- so a future edit narrowing that list still has
 * to keep every one of them accepted, not just the one this bug was found on.
 */
const assertCapabilityCallsAccepted = () => {
  // Property access, not bare identifiers -- `export` is a reserved word and
  // could never be a bare local name anyway, but `adapter.export.toSvg(...)`
  // is exactly how a real consumer reaches it, and the lookbehind only looks
  // at the text immediately before the matched `.method(`, so this exercises
  // the same receiver check a bare `interaction.onPointerDown(...)` does.
  const lines = [
    "adapter.scene.getSceneElements();",
    "adapter.text.getAppState();",
    "adapter.boardSettings.getAppState();",
    "adapter.selection.getAppState();",
    "adapter.files.getFiles();",
    "adapter.viewport.getAppState();",
    "adapter.collaboration.onChange();",
    "adapter.interaction.onPointerDown();",
    "adapter.widgets.getAppState();",
    "adapter.export.getAppState();",
    "adapter.history.getAppState();",
    "adapter.ui.getAppState();",
    "adapter.compatibility.getAppState();",
  ];
  assertAccepted(
    "capability calls with names the raw-API rule must not treat as the raw handle",
    "capabilityReceiverNames.ts",
    `export const probe = (adapter: any) => {\n  ${lines.join("\n  ")}\n};\n`,
  );
};

const assertNoExceptionsRemain = () => {
  const { RULES } = require("./adapter-boundary.cjs");
  const listed = RULES.flatMap((rule) => [...rule.exceptions].map((f) => `${rule.id}: ${f}`));
  if (listed.length > 0) {
    throw new Error(
      "The adapter boundary has exceptions again:\n  " +
        listed.join("\n  ") +
        "\nExtend the contract in frontend/src/integrations/excalidraw/capabilities.ts " +
        "instead of reaching past it, or argue the exception on NIL-322 and change this " +
        "probe deliberately.",
    );
  }

  // The assertion above only means something if it fails on a populated list.
  const populated = [{ id: "raw-api-call", exceptions: new Set(["frontend/src/x.ts"]) }];
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

  for (const [label, name, contents] of probes) assertRejects(label, name, contents);
  assertStaleExceptionCaught();
  assertLegacyKeyCaught();
  assertNoExceptionsRemain();
  assertCapabilityCallsAccepted();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Adapter boundary check proved in both directions.");
};

main();
