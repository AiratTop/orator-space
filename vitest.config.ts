import { defineConfig } from "vitest/config";

/**
 * SPEC §68 — two profiles with different costs and different jobs.
 *
 * The "domain" profile deliberately runs in plain Node. If a domain test ever needs
 * the Workers pool to pass, the ports boundary (§28.1) has been broken and this
 * configuration is how we find out.
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
      {
        test: {
          name: "integration",
          include: ["packages/adapters-cf/**/*.test.ts", "apps/edge/**/*.test.ts"],
        },
      },
    ],
  },
});
