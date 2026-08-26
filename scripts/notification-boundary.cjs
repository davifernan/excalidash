#!/usr/bin/env node
/**
 * Sonner is an implementation detail of the application notification facade.
 * Product code states message and severity through frontend/src/notifications;
 * only that facade may configure or call Sonner directly.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "frontend", "src");
const FACADE = "frontend/src/notifications/index.tsx";

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });

const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

const SONNER_ACCESS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']sonner["']/m,
  /\bimport\s*\(\s*["']sonner["']\s*\)/,
  /\brequire\s*\(\s*["']sonner["']\s*\)/,
];

const findViolations = () =>
  walk(SRC)
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) => relative(file) !== FACADE)
    .filter((file) => SONNER_ACCESS.some((pattern) => pattern.test(fs.readFileSync(file, "utf8"))))
    .map(relative);

const main = () => {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log(`Notification boundary holds. Sonner is private to ${FACADE}.`);
    return;
  }
  for (const file of violations) {
    console.error(
      `VIOLATION  ${file}: imports Sonner directly; use frontend/src/notifications instead.`,
    );
  }
  process.exitCode = 1;
};

module.exports = { FACADE, ROOT, SONNER_ACCESS, SRC, findViolations };

if (require.main === module) main();
