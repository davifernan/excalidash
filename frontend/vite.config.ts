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
    "process.env.IS_PREACT": JSON.stringify("false"),
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  };

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@excalidash/domain": path.resolve(__dirname, "../packages/domain/src"),
      },
    },
    define: {
      ...processEnvDefines,
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "import.meta.env.VITE_APP_BUILD_LABEL": JSON.stringify(buildLabel),
      "import.meta.env.VITE_EXCALIDRAW_VERSION": JSON.stringify(readExcalidrawVersion()),
    },
    optimizeDeps: {
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
