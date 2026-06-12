import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "../../src/lib/audit-runs.js": fileURLToPath(new URL("./src/lib/audit-runs.ts", import.meta.url)),
      "../../src/lib/audit-service.js": fileURLToPath(new URL("./src/lib/audit-service.ts", import.meta.url)),
      "../../src/lib/audit-template.js": fileURLToPath(new URL("./src/lib/audit-template.ts", import.meta.url)),
      "../../src/lib/cors.js": fileURLToPath(new URL("./src/lib/cors.ts", import.meta.url)),
      "../../src/lib/env.js": fileURLToPath(new URL("./src/lib/env.ts", import.meta.url)),
      "../../src/lib/logger.js": fileURLToPath(new URL("./src/lib/logger.ts", import.meta.url)),
      "../../src/lib/supabase.js": fileURLToPath(new URL("./src/lib/supabase.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
