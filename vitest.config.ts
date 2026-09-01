import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "pi-sandbox:compiled-extensions": fileURLToPath(
        new URL("./src/managed-extensions/compiled-extensions.empty.ts", import.meta.url),
      ),
      "#pi-sandbox-compiled-layout": fileURLToPath(
        new URL("./src/build-layout/default.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
