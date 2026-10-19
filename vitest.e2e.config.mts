import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    setupFiles: ["./test/assert-test-database.ts", "./test/setup-env.ts"],
    fileParallelism: false,
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
