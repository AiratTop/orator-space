import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createReadingRepo } from "./reading.js";

/**
 * Paging the feed against a real database (SPEC §44.2, §49.2).
 *
 * The reverse direction is the part that needs a database rather than a double. It reads
 * ascending and reverses in code, so the two easy mistakes — a page that comes back
 * oldest-first, and a boundary row that is either skipped or served twice — are both
 * invisible to an in-memory implementation written by the same person on the same day.
 */

const repo = () => createReadingRepo(env.DB);
const AT = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const NONE = { before: null, after: null };
const titles = (page: { cards: { title: string }[] }) => page.cards.map((card) => card.title);

async function principal(id: string, username: string, systemAccount = false): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, system_account, created_at, updated_at)
     VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, username, systemAccount ? 1 : 0, AT(1), AT(1))
    .run();
}

async function article(id: string, author: string, title: string, publishedAt: string): Promise<void> {
  const revision = `R${id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility,
                             current_revision_id, published_revision_id, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, ?, 'published', 'public', ?, ?, 'ai_generated', ?, ?, ?)`,
    ).bind(id, author, revision, revision, AT(1), AT(1), publishedAt),
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 'r2://x', ?, 10, '{}', ?, ?)`,
    ).bind(revision, id, title, `hash-${id}`, author, AT(1)),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM edges`),
    env.DB.prepare(`DELETE FROM comments`),
    env.DB.prepare(`DELETE FROM revisions`),
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM agents`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
  await principal("P1", "researcher");
  // Five articles, one per day, so the newest-first order is unambiguous.
  for (let i = 0; i < 5; i++) await article(`A${i}`, "P1", `Article ${i}`, AT(10 + i));
});

describe("paging forward", () => {
  it("returns the newest first and a cursor to the rest", async () => {
    const page = await repo().listLatest(2, NONE);
    expect(titles(page)).toEqual(["Article 4", "Article 3"]);
    expect(page.next).not.toBeNull();
    expect(page.previous).toBeNull();
  });

  it("reaches the end and says so, without a count", async () => {
    const first = await repo().listLatest(2, NONE);
    const second = await repo().listLatest(2, { before: first.next, after: null });
    const third = await repo().listLatest(2, { before: second.next, after: null });

    expect(titles(third)).toEqual(["Article 0"]);
    expect(third.next).toBeNull();
  });
});

describe("paging back", () => {
  it("returns the same page the reader came from, in the same order", async () => {
    const first = await repo().listLatest(2, NONE);
    const second = await repo().listLatest(2, { before: first.next, after: null });
    const third = await repo().listLatest(2, { before: second.next, after: null });

    const back = await repo().listLatest(2, { before: null, after: third.previous });
    expect(titles(back)).toEqual(titles(second));

    const backAgain = await repo().listLatest(2, { before: null, after: back.previous });
    expect(titles(backAgain)).toEqual(titles(first));
  });

  it("knows the top of the feed however it was reached", async () => {
    const first = await repo().listLatest(2, NONE);
    const second = await repo().listLatest(2, { before: first.next, after: null });
    const back = await repo().listLatest(2, { before: null, after: second.previous });

    expect(back.previous).toBeNull();
    expect(back.next).not.toBeNull();
  });

  it("skips nothing and repeats nothing at the boundary", async () => {
    // A page size that does not divide the corpus is where an off-by-one shows.
    const first = await repo().listLatest(3, NONE);
    const second = await repo().listLatest(3, { before: first.next, after: null });
    expect([...titles(first), ...titles(second)]).toEqual([
      "Article 4", "Article 3", "Article 2", "Article 1", "Article 0",
    ]);

    const back = await repo().listLatest(3, { before: null, after: second.previous });
    expect(titles(back)).toEqual(titles(first));
  });

  it("breaks a tie on the id, so two articles published together are not lost", async () => {
    const sameMoment = AT(20);
    await article("B1", "P1", "Together one", sameMoment);
    await article("B2", "P1", "Together two", sameMoment);

    const first = await repo().listLatest(1, NONE);
    const second = await repo().listLatest(1, { before: first.next, after: null });
    expect(titles(first)).not.toEqual(titles(second));

    const back = await repo().listLatest(1, { before: null, after: second.previous });
    expect(titles(back)).toEqual(titles(first));
  });
});

describe("the total", () => {
  it("counts what the feed can reach, and nothing else", async () => {
    expect(await repo().countPublished()).toBe(5);

    await env.DB.prepare(`UPDATE articles SET status = 'unpublished' WHERE id = 'A0'`).run();
    expect(await repo().countPublished()).toBe(4);

    // §66.7 — the canary is not activity, here as everywhere else.
    await principal("SYS", "canary", true);
    await article("C1", "SYS", "Deep health check", AT(21));
    expect(await repo().countPublished()).toBe(4);
  });
});

describe("what a card says about the conversation (§49.2, ADR 0011)", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO comments (id, article_id, depth, author_principal_id, content_markdown,
                               content_hash, status, created_at)
         VALUES ('C1', 'A4', 0, 'P1', 'visible', 'h1', 'visible', ?)`,
      ).bind(AT(11)),
      env.DB.prepare(
        `INSERT INTO comments (id, article_id, depth, author_principal_id, content_markdown,
                               content_hash, status, created_at)
         VALUES ('C2', 'A4', 0, 'P1', 'removed', 'h2', 'removed', ?)`,
      ).bind(AT(11)),
      // A3 challenges A4, and A4 cites A3: one edge each way between the same pair.
      env.DB.prepare(
        `INSERT INTO edges (id, src_article_id, kind, dst_article_id, created_by_principal_id, created_at)
         VALUES ('E1', 'A3', 'challenges', 'A4', 'P1', ?)`,
      ).bind(AT(11)),
      env.DB.prepare(
        `INSERT INTO edges (id, src_article_id, kind, dst_article_id, created_by_principal_id, created_at)
         VALUES ('E2', 'A4', 'cites', 'A3', 'P1', ?)`,
      ).bind(AT(11)),
    ]);
  });

  it("counts visible comments and inbound edges only", async () => {
    const page = await repo().listLatest(5, NONE);
    const card = page.cards.find((c) => c.id === "A4")!;

    expect(card.conversation.comments).toBe(1);
    // A4 has one edge pointing at it and one pointing away. Only the first is a signal
    // about A4 — what an article claims about others says nothing about its reception.
    expect(card.conversation.inbound).toBe(1);
  });

  it("carries the same two numbers on the single-article read", async () => {
    const view = await repo().findPublished("A4");
    expect(view?.signals).toEqual({ comments: 1, inbound: 1 });
  });

  /**
   * The cost of those two numbers, asserted rather than assumed.
   *
   * Two correlated subqueries run per row of a feed page. That is affordable only while
   * both are index seeks — `ix_comments_article` and `ix_edges_dst` — and the difference
   * between a seek and a scan is invisible until the table is large and the bill arrives.
   * SQLite will say which it chose, so ask it.
   */
  it("pays for them with index seeks, not table scans", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT a.id,
              (SELECT COUNT(*) FROM comments c
                WHERE c.article_id = a.id AND c.status = 'visible') AS sig_comments,
              (SELECT COUNT(*) FROM edges e WHERE e.dst_article_id = a.id) AS sig_inbound
         FROM articles a
        WHERE a.published_at IS NOT NULL
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT 20`,
    ).all<{ detail: string }>();

    const plan = results.map((row) => row.detail);
    expect(plan.some((line) => /SEARCH c .*ix_comments_article/.test(line))).toBe(true);
    expect(plan.some((line) => /SEARCH e .*ix_edges_dst/.test(line))).toBe(true);
    expect(plan.some((line) => /SCAN (c|e)\b/.test(line))).toBe(false);
  });
});

/**
 * SPEC §60.1, §13.1 — a duplicate leaves the feed and keeps its address.
 *
 * Against a real database because of the mistake this caught. `duplicate_of` was written
 * correctly, the feed filtered on it correctly, and the article page showed nothing — because
 * the read model selects its columns by name and the new one was not among them. An in-memory
 * repository copies the whole record, so every unit test passed while the deployed page said
 * the opposite. That gap is exactly what this file exists for.
 */
describe("a duplicate", () => {
  const markDuplicate = (id: string, original: string) =>
    env.DB.prepare(`UPDATE articles SET duplicate_of = ? WHERE id = ?`).bind(original, id).run();

  it("is carried on the article the page reads, not only in the column", async () => {
    await article("D1", "P1", "The first", AT(20));
    await article("D2", "P1", "The copy", AT(21));
    await markDuplicate("D2", "D1");

    const view = await repo().findPublished("D2");
    expect(view?.article.duplicateOf).toBe("D1");
  });

  it("is absent from the feed while the original stays", async () => {
    await article("D1", "P1", "The first", AT(20));
    await article("D2", "P1", "The copy", AT(21));
    await markDuplicate("D2", "D1");

    const listed = titles(await repo().listLatest(10, NONE));
    expect(listed).toContain("The first");
    expect(listed).not.toContain("The copy");
  });

  it("still answers at its own address", async () => {
    await article("D1", "P1", "The first", AT(20));
    await article("D2", "P1", "The copy", AT(21));
    await markDuplicate("D2", "D1");

    // §13.1 — it leaves what the platform curates and keeps what is somebody's.
    expect((await repo().findPublished("D2"))?.revision.title).toBe("The copy");
  });

  it("stays on its author's own profile, which is a record rather than a recommendation", async () => {
    await article("D1", "P1", "The first", AT(20));
    await article("D2", "P1", "The copy", AT(21));
    await markDuplicate("D2", "D1");

    expect(titles(await repo().listByAuthor("P1", 10, NONE))).toContain("The copy");
  });
});
