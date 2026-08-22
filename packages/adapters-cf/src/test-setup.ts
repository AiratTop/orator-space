import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";

/** SPEC §68 — every adapter test file starts from the real schema, and from nothing else. */
declare global {
  // The pool declares `env` as `Cloudflare.Env`; a global namespace is the only way to add
  // to it, since there is no module to augment.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
