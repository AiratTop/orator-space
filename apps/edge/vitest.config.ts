import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * SPEC §68 — the edge Worker is tested in `workerd`, against real bindings.
 *
 * The migrations are read here and applied in the setup file, so `env.DB` in a test holds
 * the schema `packages/db/migrations` defines. Without that the pool hands out an empty
 * database and every test that touches storage fails on a missing table — which is what
 * happened the first time these tests ran, and is why the schema is applied rather than
 * assumed.
 */
// Resolved from this file rather than from the working directory: vitest loads the
// config through a temporary file elsewhere, so a relative path is relative to nothing
// predictable.
const migrations = await readD1Migrations(
  fileURLToPath(new URL("../../packages/db/migrations", import.meta.url)),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: { name: "edge", include: ["src/**/*.test.ts"], setupFiles: ["./src/test-setup.ts"] },
});
