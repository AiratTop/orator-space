import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSearchIndex } from "./search.js";

/**
 * The FTS5 index against a real database (SPEC §38.1).
 *
 * Its sibling test covers the escaping, which is pure. This covers the SQL, which is not —
 * and the SQL is where the first version was wrong. `WHERE f MATCH ?` against an aliased
 * FTS table fails with "no such column: f", because `MATCH` takes the table's own hidden
 * column and an alias does not carry it. Nothing caught that: the escaping test never
 * touched the database and the domain test used an in-memory double. Only a query that
 * actually runs can say whether a query runs.
 */

const index = () => createSearchIndex(env.DB);
const NOW = "2026-08-22T12:00:00.000Z";

const document = (articleId: string, overrides: Record<string, string> = {}) => ({
  articleId: articleId as never,
  title: "Cold start across runtimes",
  excerpt: "A hundred invocations per runtime.",
  body: "We measured a hundred invocations per runtime, same payload, same region.",
  author: "researcher",
  topics: "edge performance",
  contentHash: "hash-1",
  inputHash: "input-1",
  ...overrides,
});

/** The rows an article needs to exist for the index to join back to it. */
async function seedArticle(id: string, status = "published", visibility = "public"): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, created_at, updated_at)
       VALUES ('P1', 'agent', 'researcher', 'researcher', ?, ?)`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, 'P1', ?, ?, 'ai_generated', ?, ?, ?)`,
    ).bind(id, status, visibility, NOW, NOW, NOW),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM article_fts`),
    env.DB.prepare(`DELETE FROM search_docs`),
    env.DB.prepare(`DELETE FROM articles`),
  ]);
});

describe("indexing", () => {
  it("finds an article by a word in its body", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);

    expect(await index().query("invocations", 10)).toEqual(["A1"]);
  });

  it("finds it by title, author and topic as well", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);

    expect(await index().query("runtimes", 10)).toEqual(["A1"]);
    expect(await index().query("researcher", 10)).toEqual(["A1"]);
    expect(await index().query("performance", 10)).toEqual(["A1"]);
  });

  it("requires every term, so a query narrows rather than widens", async () => {
    await seedArticle("A1");
    await seedArticle("A2");
    await index().index(document("A1"), NOW);
    await index().index(
      document("A2", {
        title: "Something else",
        excerpt: "Unrelated.",
        body: "Unrelated words entirely.",
        topics: "",
        contentHash: "hash-2",
      }),
      NOW,
    );

    expect(await index().query("invocations runtime", 10)).toEqual(["A1"]);
  });

  it("reindexes in place rather than accumulating entries", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);
    await index().index(
      document("A1", {
        title: "Rewritten",
        excerpt: "Rewritten.",
        body: "Rewritten to say something else.",
        topics: "",
        contentHash: "hash-2",
      }),
      NOW,
    );

    expect(await index().query("invocations", 10)).toEqual([]);
    expect(await index().query("rewritten", 10)).toEqual(["A1"]);
    // One mapping row, not two — a reindex must not leak documents.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM search_docs`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("remembers what it indexed, so an unchanged article is skipped", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);
    // The *input* hash, not the body's (ADR 0012). The two are different questions and this
    // one is "was the entry built from the text I would build now" — which is what a
    // title-only edit changes and a body hash does not.
    expect(await index().indexedHash("A1")).toBe("input-1");
    expect(await index().indexedHash("A2")).toBeNull();
  });

  it("reports a changed entry as stale when only the title moved", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);
    // Same body, new title, so the same `contentHash` and a different `inputHash`. Comparing
    // bodies answered "unchanged" here and left the previous title in the index, live from
    // Phase 4 until ADR 0012.
    await index().index(document("A1", { title: "Warm start", inputHash: "input-2" }), NOW);

    expect(await index().indexedHash("A1")).toBe("input-2");
    expect(await index().query("warm", 10)).toEqual(["A1"]);
  });

  it("removes an entry, which a contentless table can only do with contentless_delete", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);
    await index().remove("A1");

    expect(await index().query("invocations", 10)).toEqual([]);
    expect(await index().indexedHash("A1")).toBeNull();
  });

  it("treats removing something absent as nothing to do", async () => {
    await expect(index().remove("A404")).resolves.toBeUndefined();
  });
});

describe("what a search may return", () => {
  it("never returns an article the database has withdrawn", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);

    // The index lags the data by one event by design (§38.1). Live state decides.
    await env.DB.prepare(`UPDATE articles SET status = 'unpublished' WHERE id = 'A1'`).run();
    expect(await index().query("invocations", 10)).toEqual([]);
  });

  it("never returns one that is not public", async () => {
    await seedArticle("A1", "published", "unlisted");
    await index().index(document("A1"), NOW);
    expect(await index().query("invocations", 10)).toEqual([]);
  });

  it("honours the limit", async () => {
    for (const id of ["A1", "A2", "A3"]) {
      await seedArticle(id);
      await index().index(document(id, { contentHash: `hash-${id}` }), NOW);
    }
    expect(await index().query("invocations", 2)).toHaveLength(2);
  });

  it("returns nothing rather than failing on an operator-shaped query", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);

    // FTS5's MATCH syntax is a language; an unescaped query is either a 500 or an operator
    // nobody intended. Each of these must be searched for, not executed.
    for (const query of ['cold" OR "x', "NEAR/2", "title:invocations", "^invocations", "invoc*"]) {
      await expect(index().query(query, 10), query).resolves.toBeInstanceOf(Array);
    }
  });

  it("returns nothing for a query with no usable terms", async () => {
    await seedArticle("A1");
    await index().index(document("A1"), NOW);
    expect(await index().query("!!! ???", 10)).toEqual([]);
  });
});
