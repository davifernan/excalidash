const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packages = ["backend", "frontend"];

function runDeadCodeCheck(packageName) {
  return spawnSync("npm", ["run", "check:dead-code", "--prefix", packageName], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
}

function outputOf(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertClean(packageName, result, scenario) {
  if (result.status === 0) return;

  throw new Error(
    `${packageName} ${scenario} should pass, but exited ${result.status}\n${outputOf(result)}`,
  );
}

function assertDeadFileFound(packageName, result, relativeFile) {
  const output = outputOf(result);
  if (result.status !== 0 && output.includes(relativeFile)) return;

  throw new Error(
    `${packageName} dead-file probe was not rejected with ${relativeFile}\n` +
      `exit=${result.status}\n${output}`,
  );
}

function withProbeFiles(files, callback) {
  const createdFiles = [];
  try {
    for (const [file, contents] of files) {
      if (fs.existsSync(file)) {
        throw new Error(`Refusing to overwrite existing probe path: ${file}`);
      }
      fs.writeFileSync(file, contents, "utf8");
      createdFiles.push(file);
    }

    callback();
  } finally {
    for (const file of createdFiles) fs.rmSync(file, { force: true });
  }
}

function probePackage(packageName) {
  assertClean(packageName, runDeadCodeCheck(packageName), "baseline");

  const sourceDirectory = path.join(root, packageName, "src");
  const token = `${process.pid}_${Date.now()}`;
  const deadName = `__knip_dead_probe_${token}.ts`;
  const deadFile = path.join(sourceDirectory, deadName);

  withProbeFiles([[deadFile, "export const intentionallyDeadProbe = true;\n"]], () => {
    const result = runDeadCodeCheck(packageName);
    assertDeadFileFound(packageName, result, `src/${deadName}`);
    console.log(`${packageName}: dead file rejected (exit ${result.status})`);
  });

  const liveName = `__knip_live_probe_${token}.ts`;
  const entryName = `__knip_live_probe_${token}.test.ts`;
  const liveFile = path.join(sourceDirectory, liveName);
  const entryFile = path.join(sourceDirectory, entryName);

  withProbeFiles(
    [
      [liveFile, "export const intentionallyLiveProbe = true;\n"],
      [
        entryFile,
        `import { intentionallyLiveProbe } from "./${path.parse(liveName).name}";\n` +
          "void intentionallyLiveProbe;\n",
      ],
    ],
    () => {
      assertClean(packageName, runDeadCodeCheck(packageName), "live-file counterprobe");
    },
  );

  console.log(`${packageName}: live imported file accepted`);
}

for (const packageName of packages) probePackage(packageName);
