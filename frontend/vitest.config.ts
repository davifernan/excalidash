import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

import { readExcalidrawVersion } from "./scripts/excalidraw-version";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_EXCALIDRAW_VERSION": JSON.stringify(readExcalidrawVersion()),
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 10000,
    css: true,
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@excalidash/domain": path.resolve(__dirname, "../packages/domain/src"),
    },
  },
});
