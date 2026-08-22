import { defineConfig } from "vitest/config";

/**
 * SPEC §68 — two profiles with different costs and different jobs.
 *
 * The "domain" profile deliberately runs in plain Node. If a domain test ever needs the
 * Workers pool to pass, the ports boundary (§28.1) has been broken and this configuration
 * is how we find out.
 *
 * The other two are referenced by path rather than declared inline, so that each runs under
 * `defineWorkersConfig` and therefore actually in `workerd`. Declaring them here instead
 * looked identical and ran them in Node — which meant the profile that exists to catch
 * runtime differences was not exercising the runtime at all.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "domain",
          environment: "node",
          include: ["packages/{protocol,core,db,sdk}/**/*.test.ts"],
        },
      },
      "packages/adapters-cf/vitest.config.ts",
      "apps/edge/vitest.config.ts",
    ],
  },
});
