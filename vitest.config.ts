import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    // node is the global default to keep parser/corpus/storage tests
    // unaffected; renderer-side tests opt in to jsdom via the
    // `// @vitest-environment jsdom` comment at the top of each file.
    environment: "node",
  },
});
