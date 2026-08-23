import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createReadingRepo } from "./reading.js";

/**
 * The profile's tabs against a real database (SPEC §49.2, §18, §84).
 *
 * Both queries here join four tables and drop rows on conditions an in-memory double gets
 * right by construction — an article that is no longer public, an author who is no longer
 * active, a canary. Those are exactly the joins SQL gets wrong, and the wrong direction of
 * a `<>` on the self-citation filter is a one-character mistake with no visible symptom
 * until somebody's profile counts their own bibliography as their reception.
 */

const repo = () => createReadingRepo(env.DB);
const AT = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;

async function principal(id: string, username: string, systemAccount = false): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, system_account, created_at, updated_at)
     VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, username, systemAccount ? 1 : 0, AT(1), AT(1))
    .run();
}

async function article(id: string, author: string, title: string): Promise<void> {
  const revision = `R${id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility,
                             current_revision_id, published_revision_id, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, ?, 'published', 'public', ?, ?, 'ai_generated', ?, ?, ?)`,
    ).bind(id, author, revision, revision, AT(1), AT(1), AT(10)),
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 'r2://x', ?, 10, '{}', ?, ?)`,
    ).bind(revision, id, title, `hash-${id}`, author, AT(1)),
  ]);
}

const comment = (id: string, articleId: string, author: string, body: string, status = "visible") =>
  env.DB.prepare(
    `INSERT INTO comments (id, article_id, depth, author_principal_id, content_markdown,
                           content_hash, status, created_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
  ).bind(id, articleId, author, body, `h-${id}`, status, AT(11));

const edge = (id: string, src: string, dst: string, by: string) =>
  env.DB.prepare(
    `INSERT INTO edges (id, src_article_id, kind, dst_article_id, created_by_principal_id, created_at)
     VALUES (?, ?, 'challenges', ?, ?, ?)`,
  ).bind(id, src, dst, by, AT(11));

/** `RESEARCHER` is the profile under test; `CRITIC` is everybody else. */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM edges`),
    env.DB.prepare(`DELETE FROM comments`),
    env.DB.prepare(`DELETE FROM revisions`),
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM agents`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
  await principal("RESEARCHER", "researcher");
  await principal("CRITIC", "critic");
  await article("MINE", "RESEARCHER", "Cold start");
  await article("THEIRS", "CRITIC", "A rebuttal");
});

describe("the comments tab", () => {
  it("carries the article each comment was left on", async () => {
    await comment("C1", "THEIRS", "RESEARCHER", "Measured on what hardware?").run();

    const page = await repo().listCommentsByAuthor("RESEARCHER", 10, null);
    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]?.article.title).toBe("A rebuttal");
    expect(page.comments[0]?.article.authorUsername).toBe("critic");
    expect(page.comments[0]?.body).toBe("Measured on what hardware?");
  });

  it("withholds a removed body and keeps the row (§23.2)", async () => {
    await comment("C1", "THEIRS", "RESEARCHER", "Withdrawn", "removed").run();

    const page = await repo().listCommentsByAuthor("RESEARCHER", 10, null);
    expect(page.comments[0]?.body).toBeNull();
    expect(page.comments[0]?.status).toBe("removed");
  });

  it("drops a comment whose article is no longer public, which leaves nothing to read", async () => {
    await comment("C1", "THEIRS", "RESEARCHER", "On an article about to be withdrawn").run();
    await env.DB.prepare(`UPDATE articles SET status = 'unpublished' WHERE id = 'THEIRS'`).run();

    expect((await repo().listCommentsByAuthor("RESEARCHER", 10, null)).comments).toHaveLength(0);
  });

  it("pages newest first, by id, without repeating the boundary row", async () => {
    await env.DB.batch([
      comment("C1", "THEIRS", "RESEARCHER", "first"),
      comment("C2", "THEIRS", "RESEARCHER", "second"),
      comment("C3", "THEIRS", "RESEARCHER", "third"),
    ]);

    const first = await repo().listCommentsByAuthor("RESEARCHER", 2, null);
    expect(first.comments.map((c) => c.id)).toEqual(["C3", "C2"]);
    expect(first.next).toBe("C2");

    const second = await repo().listCommentsByAuthor("RESEARCHER", 2, first.next);
    expect(second.comments.map((c) => c.id)).toEqual(["C1"]);
    expect(second.next).toBeNull();
  });
});

describe("the citations tab", () => {
  it("lists what somebody else's article claims about this one", async () => {
    await edge("E1", "THEIRS", "MINE", "CRITIC").run();

    const page = await repo().listCitationsOf("RESEARCHER", 10, null);
    expect(page.citations).toHaveLength(1);
    expect(page.citations[0]?.source.title).toBe("A rebuttal");
    expect(page.citations[0]?.source.authorUsername).toBe("critic");
    expect(page.citations[0]?.target.title).toBe("Cold start");
  });

  it("leaves out a self-citation, which is the one an author can make alone (§84)", async () => {
    await article("MINE2", "RESEARCHER", "Cold start, revisited");
    await edge("E1", "MINE2", "MINE", "RESEARCHER").run();

    expect((await repo().listCitationsOf("RESEARCHER", 10, null)).citations).toHaveLength(0);
  });

  it("leaves out an edge whose source cannot be opened", async () => {
    await edge("E1", "THEIRS", "MINE", "CRITIC").run();
    await env.DB.prepare(`UPDATE articles SET status = 'unpublished' WHERE id = 'THEIRS'`).run();

    expect((await repo().listCitationsOf("RESEARCHER", 10, null)).citations).toHaveLength(0);
  });

  it("leaves out the platform's own canary (§66.7)", async () => {
    await principal("SYS", "canary", true);
    await article("PROBE", "SYS", "Deep health check");
    await edge("E1", "PROBE", "MINE", "SYS").run();

    expect((await repo().listCitationsOf("RESEARCHER", 10, null)).citations).toHaveLength(0);
  });

  it("ignores an edge that points at an external address", async () => {
    await env.DB.prepare(
      `INSERT INTO edges (id, src_article_id, kind, dst_uri, created_by_principal_id, created_at)
       VALUES ('E1', 'THEIRS', 'cites', 'https://example.test/paper', 'CRITIC', ?)`,
    )
      .bind(AT(11))
      .run();

    expect((await repo().listCitationsOf("RESEARCHER", 10, null)).citations).toHaveLength(0);
  });
});

describe("the counts beside the tabs", () => {
  it("counts each tab by the same rules the tab itself applies", async () => {
    await article("MINE2", "RESEARCHER", "Cold start, revisited");
    await env.DB.batch([
      comment("C1", "THEIRS", "RESEARCHER", "one"),
      comment("C2", "THEIRS", "RESEARCHER", "two"),
      edge("E1", "THEIRS", "MINE", "CRITIC"),
      // A self-citation, which the tab drops and the count must drop with it.
      edge("E2", "MINE2", "MINE", "RESEARCHER"),
    ]);

    expect(await repo().countProfile("RESEARCHER")).toEqual({
      articles: 2,
      comments: 2,
      citations: 1,
    });
  });

  it("reports zeroes for a principal who has published nothing", async () => {
    await principal("NEW", "newcomer");
    expect(await repo().countProfile("NEW")).toEqual({ articles: 0, comments: 0, citations: 0 });
  });
});
