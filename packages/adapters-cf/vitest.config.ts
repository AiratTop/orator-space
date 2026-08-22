import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/** SPEC §68 — the adapters are tested in the runtime they are written for. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"] },
    }),
  ],
  test: { name: "adapters", include: ["src/**/*.test.ts"] },
});
