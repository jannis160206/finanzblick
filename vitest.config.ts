import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Bound concurrent DOM/workbook imports instead of raising test timeouts.
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
