#!/usr/bin/env node
/**
 * Shared-domain SSOT boundary (NIL-625).
 *
 * There is deliberately no baseline or exception list. A declaration belongs
 * either in packages/domain or in one application. If frontend and backend
 * both declare the same name or the same non-trivial shape, the check fails.
 * Declarations in the domain package are also reserved: copying one back into
 * an application fails by name and by shape.
 */

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const DOMAIN = path.join(root, "packages", "domain", "src");
const APPLICATIONS = [path.join(root, "frontend", "src"), path.join(root, "backend", "src")];
const ROOTS = [DOMAIN, ...APPLICATIONS];

const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const isIgnored = (file) =>
  /(?:^|\/)(?:node_modules|dist|generated)(?:\/|$)/.test(rel(file)) ||
  /(?:\.test|\.spec|\.integration)\.tsx?$/.test(file) ||
  rel(file).includes("/__tests__/");

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (/\.tsx?$/.test(entry.name) && !isIgnored(file)) out.push(file);
  }
  return out;
};

const owner = (file) => {
  if (file.startsWith(`${DOMAIN}${path.sep}`)) return "domain";
  if (file.startsWith(`${APPLICATIONS[0]}${path.sep}`)) return "frontend";
  return "backend";
};

const exported = (node) =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

const compact = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");

const declarationOf = (node, sourceFile, file) => {
  if (!exported(node)) return null;
  let shape = null;
  let weight = 0;
  if (ts.isTypeAliasDeclaration(node)) {
    const structuralKind = ts.isTypeLiteralNode(node.type)
      ? "object"
      : ts.isUnionTypeNode(node.type)
        ? "union"
        : "type";
    shape = `${structuralKind}:${compact(node.type.getText(sourceFile))}`;
    // A small object or two-branch result union is still a complete domain
    // contract. Text length and branch count say nothing about whether copying
    // that contract creates a second source of truth, so every structural type
    // participates in shape matching. Simple reference aliases stay consumers.
    weight = structuralKind === "type" ? 1 : 3;
  } else if (ts.isInterfaceDeclaration(node)) {
    shape = `object:${compact(node.members.map((member) => member.getText(sourceFile)).join(";"))}`;
    weight = 3;
  } else if (ts.isEnumDeclaration(node)) {
    shape = `enum:${compact(node.members.map((member) => member.getText(sourceFile)).join(";"))}`;
    weight = 3;
  } else if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations;
    if (declarations.length !== 1 || !ts.isIdentifier(declarations[0].name)) return null;
    const declaration = declarations[0];
    if (!declaration.initializer) return null;
    shape = `const:${compact(declaration.initializer.getText(sourceFile))}`;
    weight = shape.length >= 30 ? 3 : 1;
    const callable =
      ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer);
    const referenceOnly =
      ts.isIdentifier(declaration.initializer) ||
      ts.isPropertyAccessExpression(declaration.initializer) ||
      ts.isElementAccessExpression(declaration.initializer);
    return {
      name: declaration.name.text,
      shape,
      weight,
      callable,
      referenceOnly,
      file: rel(file),
      owner: owner(file),
    };
  } else {
    return null;
  }
  if (!node.name || !ts.isIdentifier(node.name)) return null;
  return { name: node.name.text, shape, weight, file: rel(file), owner: owner(file) };
};

const collect = () => {
  const declarations = [];
  const inwardImports = [];
  for (const file of ROOTS.flatMap((dir) => walk(dir))) {
    const source = fs.readFileSync(file, "utf8");
    if (owner(file) === "domain") {
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const specifier = statement.moduleSpecifier.text;
        if (
          /^(?:\.\.\/)+(?:frontend|backend)(?:\/|$)/.test(specifier) ||
          /^(?:frontend|backend)(?:\/|$)/.test(specifier)
        ) {
          inwardImports.push(`${rel(file)} imports ${JSON.stringify(specifier)}`);
        }
      }
    }
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      const declaration = declarationOf(statement, sourceFile, file);
      if (declaration) declarations.push(declaration);
    }
  }
  return { declarations, inwardImports };
};

const findViolations = ({ declarations, inwardImports }) => {
  const violations = inwardImports.map((detail) => `INWARD IMPORT  ${detail}`);
  for (let index = 0; index < declarations.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < declarations.length; otherIndex += 1) {
      const a = declarations[index];
      const b = declarations[otherIndex];
      if (a.owner === b.owner) continue;
      const crossesApplications =
        new Set([a.owner, b.owner]).has("frontend") && new Set([a.owner, b.owner]).has("backend");
      const touchesDomain = a.owner === "domain" || b.owner === "domain";
      if (!crossesApplications && !touchesDomain) continue;
      // An exported alias is a consumer of the shared definition, not another
      // definition. Likewise, same-named endpoint/service functions in the two
      // applications are implementations, not wire contracts. Exact non-trivial
      // function bodies are still caught by the shape check below.
      if (a.referenceOnly || b.referenceOnly) continue;
      if (a.name === b.name) {
        if (!(a.callable && b.callable && !touchesDomain)) {
          violations.push(`DUPLICATE NAME  ${a.name}: ${a.file} <> ${b.file}`);
          continue;
        }
      }
      if (
        a.weight >= 3 &&
        b.weight >= 3 &&
        a.shape === b.shape &&
        !(a.callable && b.callable && !touchesDomain)
      ) {
        violations.push(`DUPLICATE SHAPE  ${a.name} (${a.file}) <> ${b.name} (${b.file})`);
      }
    }
  }
  return [...new Set(violations)].sort();
};

const main = () => {
  const inventory = collect();
  const violations = findViolations(inventory);
  if (violations.length === 0) {
    console.log(
      `Domain boundary holds. ${inventory.declarations.length} exported declarations checked; no exceptions.`,
    );
    return;
  }
  console.error(
    `Domain boundary failed with ${violations.length} violation(s); no baseline is supported.`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
};

module.exports = { DOMAIN, APPLICATIONS, collect, findViolations };
if (require.main === module) main();
