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
      `INSERT INTO articles (id, author_principal_id, slug, status, visibility,
                             current_revision_id, published_revision_id, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, ?, NULL, 'published', 'public', ?, ?, 'ai_generated', ?, ?, ?)`,
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
