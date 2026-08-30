import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

import { readExcalidrawVersion } from "./scripts/excalidraw-version";

const versionFilePath = path.resolve(__dirname, "../VERSION");
let versionFromFile = "0.0.0";

try {
  const raw = fs.readFileSync(versionFilePath, "utf8").trim();
  if (raw) {
    versionFromFile = raw;
  }
} catch (error) {
  console.warn("Unable to read VERSION file:", error);
}

const appVersion = process.env.VITE_APP_VERSION?.trim() || versionFromFile;
const buildLabel = process.env.VITE_APP_BUILD_LABEL?.trim() || "local development build";

export default defineConfig(({ command }) => {
  const nodeEnv = process.env.NODE_ENV || (command === "build" ? "production" : "development");
  const devBackendTarget = process.env.VITE_DEV_BACKEND_URL?.trim() || "http://localhost:8000";
  const processEnvDefines = {
    'process.env.IS_PREACT': JSON.stringify("false"),
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
  };

  return {
    plugins: [react()],
    define: {
      ...processEnvDefines,
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_BUILD_LABEL': JSON.stringify(buildLabel),
      'import.meta.env.VITE_EXCALIDRAW_VERSION': JSON.stringify(readExcalidrawVersion()),
      // NIL-649: unset/anything but "true" everywhere a real image gets
      // built -- see Editor.tsx's own comment on the harness effect for why
      // this exists and stays off by default.
      'import.meta.env.VITE_E2E_HARNESS_ENABLED': JSON.stringify(
        process.env.VITE_E2E_HARNESS_ENABLED === "true",
      ),
    },
    resolve: {
      alias: {
        // The package's `browser` export creates a DOM element at module load,
        // but Markdown parsing now also runs in a Web Worker. Its data-table
        // implementation is environment-neutral and produces identical entity
        // decoding without requiring a fake `document` in that worker.
        "decode-named-character-reference": path.resolve(
          __dirname,
          "node_modules/decode-named-character-reference/index.js",
        ),
      },
    },
    optimizeDeps: {
      // Vite's static entry scan does not traverse module workers. Without
      // these explicit entries, the first Markdown document discovers them
      // at runtime and Vite reloads the editor after re-optimizing, dropping
      // the user's current canvas selection. Keep the worker's runtime
      // imports here so a cold development/CI server is stable on first use.
      include: [
        "html-url-attributes",
        "remark-gfm",
        "remark-parse",
        "remark-rehype",
        "unified",
      ],
      esbuildOptions: {
        define: processEnvDefines,
        target: "es2022",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: devBackendTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/socket.io": {
          target: devBackendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
