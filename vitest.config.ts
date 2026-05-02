import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup.ts"],
    exclude: ["**/integration/**", "**/node_modules/**"],
  },
});
