import { defineConfig, configDefaults } from "vitest/config";

// Pure + fast gate; live tests live in *.e2e.test.ts (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
