import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSitemapRepo } from "./sitemap.js";

/**
 * What may be submitted to a search engine, against SQL rather than against a double.
 *
 * The eligibility conditions live in one string in the adapter and are repeated in the
 * in-memory double, which is the one duplication the doubles accept — so the string itself
 * needs a test that runs it. §66.7's exclusion is the reason this file exists: it is a join
 * to another table inside a `WHERE` that had only column comparisons in it before, and it is
 * enforced nowhere else on this path.
 */

const repo = () => createSitemapRepo(env.DB);
const AT = "2026-08-15T10:00:00.000Z";

const principal = (id: string, username: string, systemAccount: boolean) =>
  env.DB.prepare(
    `INSERT INTO principals (id, kind, username, username_skeleton, system_account, created_at, updated_at)
     VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
  ).bind(id, username, username, systemAccount ? 1 : 0, AT, AT);

const article = (id: string, author: string, extra: { canonicalUrl?: string; indexable?: number } = {}) =>
  env.DB.prepare(
    `INSERT INTO articles (id, author_principal_id, status, visibility, authorship_disclosure,
                           indexable, canonical_url, created_at, updated_at, published_at)
     VALUES (?, ?, 'published', 'public', 'ai_generated', ?, ?, ?, ?, ?)`,
  ).bind(id, author, extra.indexable ?? 1, extra.canonicalUrl ?? null, AT, AT, AT);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
  await env.DB.batch([principal("P1", "researcher", false), principal("P2", "canary-staging", true)]);
});

describe("what a shard may carry (SPEC §51, §15.1, §66.7)", () => {
  it("lists a published, public, indexable article", async () => {
    await article("A1", "P1").run();
    expect((await repo().articlesIn("2026-08", 10)).map((row) => row.id)).toEqual(["A1"]);
  });

  it("leaves out the canary's, whose URL is a tombstone within seconds (§66.7)", async () => {
    await env.DB.batch([article("A1", "P1"), article("A2", "P2")]);
    expect((await repo().articlesIn("2026-08", 10)).map((row) => row.id)).toEqual(["A1"]);
  });

  it("leaves out a cross-post, whose primary copy is somebody else's (§15.1)", async () => {
    await article("A1", "P1", { canonicalUrl: "https://elsewhere.test/x" }).run();
    expect(await repo().articlesIn("2026-08", 10)).toEqual([]);
  });

  it("leaves out an article that has not earned indexing (§50.3)", async () => {
    await article("A1", "P1", { indexable: 0 }).run();
    expect(await repo().articlesIn("2026-08", 10)).toEqual([]);
  });
});
