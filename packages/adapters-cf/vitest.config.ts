import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * SPEC §68 — the adapters are tested in the runtime they are written for, against a real
 * database.
 *
 * A D1 binding rather than a double, because an adapter's whole job is the SQL. The first
 * version of the search query passed a unit test of its escaping and a domain test of its
 * behaviour, and then failed on the first real request with a syntax error — the SQL itself
 * had never been executed by anything.
 */
const migrations = await readD1Migrations(
  fileURLToPath(new URL("../db/migrations", import.meta.url)),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "adapters-test" },
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: { name: "adapters", include: ["src/**/*.test.ts"], setupFiles: ["./src/test-setup.ts"] },
});
