import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";
import type { Env as WorkerEnv } from "./index.js";

/**
 * Gives every test file the real schema (SPEC §68).
 *
 * The pool isolates storage per test file, so this runs once per file and each one starts
 * from an empty database with the migrations applied. Tests therefore cannot depend on
 * each other's rows, which is the property that makes them worth trusting when they pass
 * in a different order.
 */
type TestBindings = WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };

declare global {
  // The pool declares `env` as `Cloudflare.Env`, and a global namespace is the only way
  // to add to it — there is no module to augment. The rule is right everywhere else.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    /** The Worker's own bindings, plus what the pool injects for the setup below. */
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  const bindings = env as TestBindings;
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
