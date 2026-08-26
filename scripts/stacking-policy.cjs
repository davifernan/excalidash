#!/usr/bin/env node
/**
 * Reject raw z-index numbers in first-party frontend source (NIL-607).
 *
 * Excalidraw's package stylesheet is intentionally not scanned: node_modules,
 * generated/minified CSS and explicitly vendored stylesheet directories are
 * foreign inputs, not policy violations. Product code must ask the adapter in
 * frontend/src/integrations/excalidraw/stacking.{css,ts} for a semantic role.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.env.STACKING_POLICY_ROOT || path.join(__dirname, ".."));
const sourceRoot = path.join(root, "frontend", "src");
const adapterStyles = "frontend/src/integrations/excalidraw/stacking.css";
const ignoredDirectories = new Set(["node_modules", "dist", "coverage", "vendor", "third_party"]);
const sourceExtensions = new Set([".css", ".scss", ".ts", ".tsx", ".js", ".jsx"]);

const normalize = (file) => path.relative(root, file).split(path.sep).join("/");

const isForeignStylesheet = (file) => {
  const name = path.basename(file);
  return name.endsWith(".min.css") || name.endsWith(".vendor.css");
};

const isTestFile = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);

const walk = (directory) => {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
};

const patterns = [
  { name: "CSS z-index", re: /\bz-index\s*:\s*-?(?:\d+|\.\d+)/g },
  { name: "inline zIndex", re: /\bzIndex\s*:\s*(?:["'`]\s*)?-?(?:\d+|\.\d+)/g },
  {
    name: "numeric utility z-index",
    re: /(?:^|[\s"'`])(?:[a-z-]+:)*z-(?:\[\s*-?\d+(?:\.\d+)?\s*\]|-?\d+)(?=$|[\s"'`])/g,
  },
];

const scan = () => {
  const findings = [];
  for (const file of walk(sourceRoot)) {
    const relative = normalize(file);
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) continue;
    if (relative === adapterStyles || isTestFile(file) || isForeignStylesheet(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        pattern.re.lastIndex = 0;
        if (pattern.re.test(line)) {
          findings.push({ file: relative, line: index + 1, rule: pattern.name, text: line.trim() });
        }
      }
    });
  }
  return findings;
};

const main = () => {
  const findings = scan();
  if (findings.length === 0) {
    console.log("Stacking policy: no raw first-party z-index numbers.");
    return;
  }
  console.error("Stacking policy violations (use a semantic role from the Excalidraw adapter):");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  }
  process.exitCode = 1;
};

if (require.main === module) main();

module.exports = { adapterStyles, isForeignStylesheet, isTestFile, patterns, scan, sourceRoot };
