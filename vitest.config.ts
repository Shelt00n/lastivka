import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Fixed timezone so date formatting tests are deterministic on any machine / CI.
    env: { TZ: "Europe/Kyiv" },
  },
});
