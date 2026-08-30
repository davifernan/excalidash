#!/usr/bin/env node
/**
 * Reject duplicate static keys in repository configuration (NIL-708).
 *
 * JSON.parse and most JavaScript bundlers use "last key wins" semantics. That
 * makes a duplicate configuration block look valid while silently discarding
 * the earlier value. This check deliberately parses configuration without
 * executing it: TypeScript gives us the object-literal AST for JSON, JS and
 * TS, while js-yaml rejects duplicate mapping keys with source locations.
 *
 * Dynamic JavaScript keys and spread properties are intentionally out of
 * scope. They cannot be identified without evaluating configuration; the
 * guard covers only duplicate keys whose names are statically visible.
 */

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..", "..");
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
  "playwright-report",
  "test-results",
]);

const isJsonConfig = (relative) => {
  const base = path.basename(relative);
  return (
    base === "package.json" ||
    base === "knip.json" ||
    base === ".prettierrc.json" ||
    /^tsconfig(?:\.[^.]+)?\.json$/.test(base)
  );
};

const isYamlConfig = (relative) => /\.ya?ml$/i.test(relative);

const isJavaScriptConfig = (relative) =>
  /(?:^|\/)(?:vite|vitest|playwright|eslint|postcss|tailwind)\.config\.(?:[cm]?[jt]s)$/i.test(
    relative,
  );

const walkFiles = (directory, relative = "") => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name) ? [] : walkFiles(child, childRelative);
    }
    return entry.isFile() ? [childRelative.split(path.sep).join("/")] : [];
  });
};

const discoverConfigFiles = () =>
  walkFiles(root)
    .filter(
      (relative) =>
        isJsonConfig(relative) || isYamlConfig(relative) || isJavaScriptConfig(relative),
    )
    .sort();

const lineAndColumn = (source, position) => {
  const before = source.slice(0, position);
  return {
    line: before.split("\n").length,
    column: position - before.lastIndexOf("\n"),
  };
};

const staticPropertyName = (name) => {
  if (!name || ts.isComputedPropertyName(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
};

const propertyName = (member) => {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isShorthandPropertyAssignment(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return staticPropertyName(member.name);
  }
  return undefined;
};

const scanObjectLiterals = (relative, source, scriptKind) => {
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
  const findings = [];

  for (const diagnostic of file.parseDiagnostics) {
    const position = diagnostic.start ?? 0;
    const { line, column } = lineAndColumn(source, position);
    findings.push(
      `${relative}:${line}:${column}: invalid configuration syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Map();
      for (const member of node.properties) {
        const name = propertyName(member);
        if (name === undefined) continue;
        const prior = seen.get(name);
        if (prior) {
          const { line, column } = lineAndColumn(source, member.name.getStart(file));
          const { line: priorLine, column: priorColumn } = lineAndColumn(
            source,
            prior.name.getStart(file),
          );
          findings.push(
            `${relative}:${line}:${column}: duplicate key ${JSON.stringify(name)} (first defined at ${relative}:${priorLine}:${priorColumn})`,
          );
        } else {
          seen.set(name, member);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
};

const scanYaml = (relative, source) => {
  try {
    yaml.load(source);
    return [];
  } catch (error) {
    const line = error.mark ? error.mark.line + 1 : 1;
    const column = error.mark ? error.mark.column + 1 : 1;
    return [`${relative}:${line}:${column}: ${error.reason ?? error.message}`];
  }
};

const scanFile = (relative) => {
  const absolute = path.isAbsolute(relative) ? relative : path.join(root, relative);
  const display = path.isAbsolute(relative)
    ? path.relative(root, relative).split(path.sep).join("/")
    : relative;
  const source = fs.readFileSync(absolute, "utf8");
  if (isYamlConfig(display)) return scanYaml(display, source);
  if (isJsonConfig(display)) return scanObjectLiterals(display, source, ts.ScriptKind.JSON);
  if (isJavaScriptConfig(display)) {
    return scanObjectLiterals(
      display,
      source,
      /\.tsx?$/i.test(display) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
  }
  return [`${display}: not a supported configuration file`];
};

const validateFiles = (files = discoverConfigFiles()) => files.flatMap(scanFile);

const main = () => {
  const args = process.argv.slice(2);
  const files = args.length === 0 ? undefined : args;
  const findings = validateFiles(files);
  if (findings.length > 0) {
    console.error("Duplicate or invalid configuration keys found:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  }
};

if (require.main === module) main();

module.exports = { discoverConfigFiles, scanFile, validateFiles };
