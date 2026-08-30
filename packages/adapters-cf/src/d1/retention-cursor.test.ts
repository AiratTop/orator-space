import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createRetentionCursorRepo } from "./journals.js";

/**
 * The checkpoint a sweep resumes from, against a real database (SPEC §32.2, §68).
 *
 * Small enough to look obviously right and load-bearing enough to be worth executing: the
 * whole point of the table is that a Cron invocation ends and the position survives it, so
 * an upsert that silently inserted a second row, or a delete that missed, would turn every
 * run into a fresh sweep from the beginning — which is the failure this table was added to
 * fix, restored by the code meant to fix it.
 */

const repo = () => createRetentionCursorRepo(env.DB);
const AT = "2026-08-31T12:00:00.000Z";
const LATER = "2026-08-31T13:00:00.000Z";

/** `PendingWrite` is the prepared statement itself, opaque to the domain (see `asWrite`). */
const commit = async (write: unknown) => env.DB.batch([write as D1PreparedStatement]);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM retention_cursors").run();
});

describe("retention cursors (§32.2)", () => {
  it("has nothing to say about a sweep that has never run", async () => {
    expect(await repo().read("content")).toBeNull();
  });

  it("remembers where a sweep got to", async () => {
    await commit(repo().write("content", "page-two", AT));
    expect(await repo().read("content")).toBe("page-two");
  });

  it("replaces the position rather than adding a second row", async () => {
    await commit(repo().write("content", "page-two", AT));
    await commit(repo().write("content", "page-three", LATER));

    expect(await repo().read("content")).toBe("page-three");
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM retention_cursors WHERE handler = 'content'`,
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it("deletes the row when the sweep finishes, so absent means start over", async () => {
    await commit(repo().write("content", "page-two", AT));
    await commit(repo().write("content", null, LATER));

    expect(await repo().read("content")).toBeNull();
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM retention_cursors`,
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });

  it("keeps one handler's position out of another's", async () => {
    // The table is general on purpose — media has the same listing problem the day its
    // bucket outgrows a page — so the key has to actually separate them.
    await commit(repo().write("content", "content-page", AT));
    await commit(repo().write("media", "media-page", AT));

    expect(await repo().read("content")).toBe("content-page");
    expect(await repo().read("media")).toBe("media-page");

    await commit(repo().write("content", null, LATER));
    expect(await repo().read("media")).toBe("media-page");
  });
});
