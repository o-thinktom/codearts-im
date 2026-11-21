import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const abs = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@codearts-qqbot/core": abs("./packages/qqbot-core/src/index.ts"),
      "@codearts-qqbot/ipc": abs("./packages/qqbot-ipc/src/index.ts"),
      "@codearts-qqbot/kernel-port": abs("./packages/qqbot-kernel-port/src/index.ts"),
      "@codearts-qqbot/runtime": abs("./packages/qqbot-runtime/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});