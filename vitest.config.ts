import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@content": path.resolve(__dirname, "src/content"),
      "@youtube": path.resolve(__dirname, "src/youtube"),
      "@background": path.resolve(__dirname, "src/background")
    }
  }
});
