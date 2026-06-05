import { defineConfig, configDefaults } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    globals: true,
    testTimeout: 20000, 
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [...configDefaults.exclude, "**/*.wtr.test.ts"],
    deps: {
      optimizer: { ssr: { include: ["@effect/vitest"] } },
    },
    fileParallelism: true,
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup-worker.ts"],
    maxWorkers: 4, 
  },
}));
