import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(frontendRoot, "node_modules", "@excalidraw", "excalidraw");
const packageJsonPath = path.join(packageRoot, "package.json");
const expectedVersion = "0.18.1";
const exportName = "ExcalidrawCommandPalette";

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== expectedVersion) {
  throw new Error(
    `[excalidraw-command-palette] Expected @excalidraw/excalidraw ${expectedVersion}, found ${String(packageJson.version)}. Re-audit the native command-palette export before updating this seam.`,
  );
}

const patchFile = (relativePath, marker, replacement) => {
  const target = path.join(packageRoot, relativePath);
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(exportName)) return false;
  const first = source.indexOf(marker);
  const last = source.lastIndexOf(marker);
  if (first === -1 || first !== last) {
    throw new Error(
      `[excalidraw-command-palette] ${relativePath} no longer has exactly one audited export marker.`,
    );
  }
  fs.writeFileSync(target, source.replace(marker, replacement));
  return true;
};

const changed = [
  patchFile(
    "dist/dev/index.js",
    "export {\n  Button,",
    `export {\n  CommandPalette as ${exportName},\n  Button,`,
  ),
  patchFile(
    "dist/prod/index.js",
    "export{Gt as Button,",
    `export{VK as ${exportName},Gt as Button,`,
  ),
  patchFile(
    "dist/types/excalidraw/index.d.ts",
    "export { LiveCollaborationTrigger };",
    `export { LiveCollaborationTrigger };\nexport { CommandPalette as ${exportName} } from "./components/CommandPalette/CommandPalette";`,
  ),
].some(Boolean);

process.stdout.write(
  changed
    ? `[excalidraw-command-palette] Exposed the native ${expectedVersion} component.\n`
    : `[excalidraw-command-palette] Native component already exposed.\n`,
);
