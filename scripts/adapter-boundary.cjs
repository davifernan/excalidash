#!/usr/bin/env node
/**
 * Architecture check for the Excalidraw compatibility layer (NIL-335).
 *
 * Product code states intent through local capabilities. Only the integration
 * layer knows the raw package, the editor's internal DOM, or how to fake an
 * input event. This check keeps it that way.
 *
 * The exception lists below are named files, not a wildcard. They are the
 * measured starting state -- every place that reaches past the boundary today
 * -- and they shrink to nothing as consumers migrate. A wildcard would let a
 * new violation hide behind an old one.
 *
 * Every rule is proved in both directions by scripts/adapter-boundary.test.cjs:
 * a check nobody has watched fail is not a check.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "frontend", "src");
const LAYER = path.join("frontend", "src", "integrations", "excalidraw");
const DOM_BRIDGE = path.join(LAYER, "domBridge.ts");
const CUSTOM_DATA_HELPER = path.join(LAYER, "customData.ts");

/**
 * Files that still import the package directly.
 *
 * Measured on main 85c3919. Sixteen entries; the list is emptied by the
 * consumer migration (NIL-336 to NIL-340), not extended.
 */
const PACKAGE_IMPORT_EXCEPTIONS = new Set([
  "frontend/src/components/LanguageSelector.tsx",
  "frontend/src/components/drawing-card/useDrawingPreview.ts",
  "frontend/src/main.tsx",
  "frontend/src/pages/editor/EditorDialogs.tsx",
  "frontend/src/pages/editor/EditorView.tsx",
  "frontend/src/pages/editor/documentDrop.ts",
  "frontend/src/pages/editor/followMode.ts",
  "frontend/src/pages/editor/inviteHere.ts",
  "frontend/src/pages/editor/pdfWidgetElements.ts",
  "frontend/src/pages/editor/useEditorCanvasHandlers.ts",
  "frontend/src/pages/editor/useEditorPersistence.ts",
  "frontend/src/sticky/StickyHandles.tsx",
  "frontend/src/sticky/stickyFit.ts",
  "frontend/src/sticky/stickyNormalise.ts",
  "frontend/src/sticky/stickyNote.ts",
  "frontend/src/utils/importHelpers.ts",
]);

/** Files that still reach into the editor's own DOM. */
const DOM_INTERNAL_EXCEPTIONS = new Set([
  "frontend/src/pages/editor/useExcalidrawRoot.ts",
  "frontend/src/pages/editor/useExcalidrawUiState.ts",
  "frontend/src/pages/editor/wheelZoom.ts",
  "frontend/src/sticky/StickyPalette.tsx",
  "frontend/src/sticky/stickyPlacement.ts",
  "frontend/src/sticky/useToolbarElement.ts",
]);

/** Files that still synthesise input events. */
const SYNTHETIC_EVENT_EXCEPTIONS = new Set([
  "frontend/src/pages/editor/wheelZoom.ts",
  "frontend/src/sticky/stickyConnect.ts",
  "frontend/src/sticky/stickyPlacement.ts",
]);

/** Files that still write customData without the central helper. */
const CUSTOM_DATA_WRITE_EXCEPTIONS = new Set([
  "frontend/src/pages/editor/pdfWidgetElements.ts",
  "frontend/src/sticky/stickyNormalise.ts",
  "frontend/src/sticky/stickyNote.ts",
]);

/**
 * Both import forms.
 *
 * The dynamic one is not decoration: useDrawingPreview.ts reaches the package
 * through `await import("@excalidraw/excalidraw")`, and a check that greps only
 * for `from "@excalidraw"` misses it and reports green. That file was missed
 * exactly that way while this seam was being inventoried.
 */
const PACKAGE_PATTERNS = [
  { name: "static import", re: /(?:^|\n)\s*import\s[^;]*?from\s*["']@excalidraw\//s },
  { name: "dynamic import", re: /\bimport\s*\(\s*["']@excalidraw\//s },
  { name: "require", re: /\brequire\s*\(\s*["']@excalidraw\// },
  { name: "side-effect import", re: /(?:^|\n)\s*import\s*["']@excalidraw\// },
];

/** Class names Excalidraw owns. Ours are excluded by the leading dot plus name. */
const DOM_INTERNAL_PATTERNS = [
  /\.App-toolbar\b/,
  /\.App-menu\b/,
  /\.App-menu_top/,
  /\.layer-ui__wrapper\b/,
  /\.excalidraw--mobile\b/,
  /\.excalidraw-hyperlinkContainer\b/,
  /\.disable-zen-mode--visible\b/,
  /querySelector[^\n]*["'`][^"'`]*\.excalidraw\b/,
];

const SYNTHETIC_EVENT_PATTERNS = [
  /new\s+KeyboardEvent\s*\(/,
  /new\s+PointerEvent\s*\(/,
  /new\s+WheelEvent\s*\(/,
  /new\s+MouseEvent\s*\(/,
];

const CUSTOM_DATA_WRITE_PATTERNS = [/customData\s*:/];

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

const RULES = [
  {
    id: "package-import",
    patterns: PACKAGE_PATTERNS,
    exceptions: PACKAGE_IMPORT_EXCEPTIONS,
    allow: (relative) => relative.startsWith(`${LAYER.split(path.sep).join("/")}/`),
    message:
      "imports @excalidraw/excalidraw directly. Use a capability from " +
      "frontend/src/integrations/excalidraw instead.",
  },
  {
    id: "dom-internal",
    patterns: DOM_INTERNAL_PATTERNS.map((re) => ({ name: "internal selector", re })),
    exceptions: DOM_INTERNAL_EXCEPTIONS,
    allow: (relative) => relative === DOM_BRIDGE.split(path.sep).join("/"),
    message: "names an Excalidraw-internal class. Those belong in domBridge.ts.",
  },
  {
    id: "synthetic-event",
    patterns: SYNTHETIC_EVENT_PATTERNS.map((re) => ({ name: "synthetic event", re })),
    exceptions: SYNTHETIC_EVENT_EXCEPTIONS,
    allow: (relative) => relative === DOM_BRIDGE.split(path.sep).join("/"),
    message: "synthesises an input event. Those belong in domBridge.ts.",
  },
  {
    id: "custom-data-write",
    patterns: CUSTOM_DATA_WRITE_PATTERNS.map((re) => ({ name: "customData write", re })),
    exceptions: CUSTOM_DATA_WRITE_EXCEPTIONS,
    // The whole layer, not just the helper: types.ts has to be able to declare
    // the field, and a type declaration is not a write.
    allow: (relative) =>
      relative === CUSTOM_DATA_HELPER.split(path.sep).join("/") ||
      relative.startsWith(`${LAYER.split(path.sep).join("/")}/`),
    message: "writes customData directly. Go through integrations/excalidraw/customData.ts.",
  },
];

const main = () => {
  if (!fs.existsSync(SRC)) {
    console.error(`No frontend source at ${SRC}`);
    process.exit(2);
  }

  const files = walk(SRC).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
  const violations = [];
  const usedExceptions = new Map(RULES.map((rule) => [rule.id, new Set()]));

  for (const file of files) {
    const relative = rel(file);
    const contents = fs.readFileSync(file, "utf8");

    for (const rule of RULES) {
      const hit = rule.patterns.find(({ re }) => re.test(contents));
      if (!hit) continue;
      if (rule.allow(relative)) continue;
      if (rule.exceptions.has(relative)) {
        usedExceptions.get(rule.id).add(relative);
        continue;
      }
      violations.push(`${relative}: ${rule.message} (${hit.name})`);
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
      `Adapter boundary holds. ${files.length} files checked, ${total} named exceptions remaining.`,
    );
    process.exit(0);
  }

  for (const line of violations) console.error(`VIOLATION  ${line}`);
  for (const line of stale) console.error(`STALE      ${line}`);
  process.exit(1);
};

main();
