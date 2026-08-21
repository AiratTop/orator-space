import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: { workers: { miniflare: { compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"] } } },
  },
});
