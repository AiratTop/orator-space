import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * SPEC §68 — the edge Worker is tested in `workerd`, against real bindings.
 *
 * `wrangler.jsonc` supplies them, so `env` in a test is the same D1 and R2 the Worker gets
 * at runtime rather than a mock of them.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { name: "edge", include: ["src/**/*.test.ts"] },
});
