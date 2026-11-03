import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", fileParallelism: false, testTimeout: 30000, setupFiles: ["tests/setup.ts"] },
});
