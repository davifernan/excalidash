import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Excalidraw version this build is actually running against.
 *
 * Read from the installed package rather than written down somewhere, so a
 * diagnostic reports what is there and not what somebody remembered to update.
 * The package does not export its own package.json, so it is read from disk at
 * config time and injected -- the same shape the app version already uses.
 */
export const readExcalidrawVersion = (): string => {
  try {
    let packageDirectory = path.dirname(
      fileURLToPath(import.meta.resolve("@excalidraw/excalidraw")),
    );
    while (packageDirectory !== path.dirname(packageDirectory)) {
      const candidate = path.join(packageDirectory, "package.json");
      if (fs.existsSync(candidate)) {
        const candidatePackage = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (candidatePackage.name === "@excalidraw/excalidraw") {
          return typeof candidatePackage.version === "string" && candidatePackage.version
            ? candidatePackage.version
            : "unknown";
        }
      }
      packageDirectory = path.dirname(packageDirectory);
    }
    const manifest = path.join(
      frontendRoot,
      "node_modules",
      "@excalidraw",
      "excalidraw",
      "package.json",
    );
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
};
