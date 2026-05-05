import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const renderRoot = resolve(import.meta.dirname, "src");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(import.meta.dirname, "electron/main.ts") },
      rollupOptions: { output: { format: "es" } },
      outDir: resolve(import.meta.dirname, "out/main"),
    },
    resolve: {
      alias: { "@": renderRoot },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // CJS, not ESM — sandboxed preloads (BrowserWindow.webPreferences.sandbox
      // = true) must be CommonJS. Electron's sandbox runtime cannot evaluate
      // ESM preloads; the script silently fails with "Cannot use import
      // statement outside a module" and `window.api` never gets exposed.
      lib: { entry: resolve(import.meta.dirname, "electron/preload.ts") },
      rollupOptions: { output: { format: "cjs" } },
      outDir: resolve(import.meta.dirname, "out/preload"),
    },
    resolve: {
      alias: { "@": renderRoot },
    },
  },
  renderer: {
    root: renderRoot,
    plugins: [react()],
    resolve: {
      alias: { "@": renderRoot },
    },
    build: {
      outDir: resolve(import.meta.dirname, "out/renderer"),
      rollupOptions: {
        input: { index: resolve(renderRoot, "index.html") },
      },
    },
    server: { port: 5173, strictPort: true },
  },
});
