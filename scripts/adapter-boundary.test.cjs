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
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const { SRC: REAL_SRC, LEGACY_SCAN_ROOTS } = require("./adapter-boundary.cjs");

/**
 * This check's own scan reaches past frontend/src -- the legacy-key sweep also
 * reads backend/src and e2e/tests -- so a probe cycle that only isolated
 * frontend/src would still race authz-boundary.test.cjs writing into
 * backend/src/__authz_probe__ (NIL-493). Copying every directory the check can
 * read, plus the check script itself so its own root resolves inside the
 * copy, is what actually stops the two files from meeting.
 *
 * Derived from SRC and LEGACY_SCAN_ROOTS (Hans-Friedrich, PR #64) rather than
 * a second hard-coded list: a directory added to either constant is copied
 * here automatically instead of silently staying unswept in the sandbox
 * while the real check on CI keeps reading it.
 */
const root = createSandbox(
  repoRoot,
  [
    ...new Set([
      path.relative(repoRoot, REAL_SRC).split(path.sep).join("/"),
      ...LEGACY_SCAN_ROOTS,
      "scripts/adapter-boundary.cjs",
    ]),
  ],
  "adapter-boundary-sandbox-",
);
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
  ["un-inventoried CSS selector", "cssSelector.css", ".App-menu { display: none; }\n"],
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
    "CSS selector that only shares the help-icon prefix with inventory",
    "cssHelpIconPrefix.css",
    ".help-icon-badge { top: 0; }\n",
  ],
  [
    "CSS selector that only shares the sidebar-trigger prefix with inventory",
    "cssSidebarTriggerPrefix.css",
    ".sidebar-trigger--secondary { display: none; }\n",
  ],
  [
    "CSS selector that only shares the main-menu-trigger prefix with inventory",
    "cssMainMenuTriggerPrefix.css",
    ".main-menu-trigger--experimental { color: red; }\n",
  ],
  [
    "CSS selector that only shares the Island prefix with inventory",
    "cssIslandPrefix.css",
    ".Island--dragging { opacity: .5; }\n",
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
 * receiver awareness at all. `interaction` is the one real capability call
 * shape this rule must keep accepting -- the receiver whose real methods
 * (`onPointerDown`, `setActiveTool`) actually collide with RAW_API_PATTERNS.
 */
const assertCapabilityCallsAccepted = () => {
  assertAccepted(
    "a capability call the raw-API rule must not treat as the raw handle",
    "capabilityReceiverNames.ts",
    "export const probe = (adapter: any) => {\n  adapter.interaction.onPointerDown();\n};\n",
  );
};

/**
 * PR #61 (Hans-Friedrich): CAPABILITY_RECEIVER_NAMES used to exempt all
 * thirteen of ExcalidrawAdapter's property names by text alone, with no way
 * to tell a real capability from a same-named unrelated variable. Checked
 * mechanically against capabilities.ts, only `InteractionCapability` names a
 * method that collides with RAW_API_PATTERNS -- the other twelve receiver
 * names never needed the exemption, so narrowing the list to `interaction`
 * only closes a hole the rule never should have had open. This probe is the
 * direction that proves it stayed closed: a raw-shaped call through any of
 * the other twelve names is a real violation again, not a silent pass.
 */
const assertNonInteractionReceiverNamesRejected = () => {
  const lines = [
    "scene.getSceneElements();",
    "text.getAppState();",
    "boardSettings.getAppState();",
    "selection.getAppState();",
    "files.getFiles();",
    "viewport.getAppState();",
    "collaboration.onChange();",
    "widgets.getAppState();",
    "history.getAppState();",
    "ui.getAppState();",
    "compatibility.getAppState();",
  ];
  for (const line of lines) {
    assertRejects(
      `a raw-shaped call through a non-interaction receiver name (${line})`,
      "nonInteractionReceiver.ts",
      `export const probe = (scene: any, text: any, boardSettings: any, selection: any, files: any, viewport: any, collaboration: any, widgets: any, history: any, ui: any, compatibility: any) => {\n  ${line}\n};\n`,
    );
  }
};

/**
 * PR #61 fix-push: `node --test scripts/*.test.cjs` runs test FILES
 * concurrently, and scanForLegacyKeys walks backend/src and e2e/tests too --
 * directories this script does not own. authz-boundary.test.cjs's own
 * probes live under backend/src/__authz_probe__/ for the width of one
 * assertion (mkdirSync before, rmSync after). A concurrent run hit exactly
 * that: this scan's directory listing saw a probe file authz-boundary had
 * already deleted by the time this read it -- ENOENT, uncaught, the whole
 * check crashed instead of reporting a result. Reproduced deterministically
 * here (no real race needed) by making fs.readFileSync/readdirSync throw
 * ENOENT for one specific path scanForLegacyKeys/walk is mid-scanning.
 */
const assertLegacyKeyScanToleratesADisappearingFile = () => {
  // Must be the sandboxed copy, not the real "./adapter-boundary.cjs": that
  // module's own root resolves from its OWN file location, and requiring the
  // real one here would make scanForLegacyKeys walk the real frontend/src --
  // which never contains PROBE_DIR now that probes only exist inside the
  // sandbox. Without this, the stub below never intercepts a real read and
  // this test passes without ever exercising the ENOENT path it names.
  const { scanForLegacyKeys } = require(CHECK);
  if (fs.existsSync(PROBE_DIR)) {
    throw new Error(`Refusing to reuse an existing probe directory: ${PROBE_DIR}`);
  }
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const vanishing = path.join(PROBE_DIR, "vanishing.ts");
  fs.writeFileSync(vanishing, "export const probe = 1;\n", "utf8");
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (file === vanishing) {
      const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
      error.code = "ENOENT";
      throw error;
    }
    return originalReadFileSync(file, ...rest);
  };
  try {
    const hits = scanForLegacyKeys("frontend/src");
    if (!Array.isArray(hits)) {
      throw new Error("scanForLegacyKeys did not return normally past the disappearing file.");
    }
    console.log("  legacy-key scan survives a file that vanishes mid-scan (ENOENT, not a crash)");
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

const assertWalkToleratesADisappearingDirectory = () => {
  // Same reason as assertLegacyKeyScanToleratesADisappearingFile: use the
  // sandboxed copy consistently, even though this call happens to pass an
  // explicit directory and would work with either module reference today.
  const { walk } = require(CHECK);
  if (fs.existsSync(PROBE_DIR)) {
    throw new Error(`Refusing to reuse an existing probe directory: ${PROBE_DIR}`);
  }
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const vanishingDir = path.join(PROBE_DIR, "vanishing-dir");
  fs.mkdirSync(vanishingDir);
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = (dir, ...rest) => {
    if (dir === vanishingDir) {
      const error = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
      error.code = "ENOENT";
      throw error;
    }
    return originalReaddirSync(dir, ...rest);
  };
  try {
    const files = walk(PROBE_DIR);
    if (!Array.isArray(files)) {
      throw new Error("walk did not return normally past the disappearing directory.");
    }
    console.log("  walk survives a directory that vanishes mid-recursion (ENOENT, not a crash)");
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

const assertNoExceptionsRemain = () => {
  // RULES's content is identical either way (same bytes, just copied), but
  // requiring the sandboxed module consistently avoids relying on that.
  const { RULES } = require(CHECK);
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
  const wouldList = populated.flatMap((rule) =>
    [...rule.exceptions].map((f) => `${rule.id}: ${f}`),
  );
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
  assertNonInteractionReceiverNamesRejected();
  assertLegacyKeyScanToleratesADisappearingFile();
  assertWalkToleratesADisappearingDirectory();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Adapter boundary check proved in both directions.");
};

try {
  main();
} finally {
  removeSandbox(root);
}
