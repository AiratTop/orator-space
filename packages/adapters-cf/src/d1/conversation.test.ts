import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createReadingRepo } from "./reading.js";

/**
 * The conversation query against a real database (SPEC §76, §84, §33.2).
 *
 * The SQL here is the whole of the feature. Three things in it are easy to get wrong in a
 * way no in-memory double would notice: the visibility filter on the far end of an edge
 * sits in the `ON` clause rather than the `WHERE`, so an edge pointing at a draft survives
 * as an edge; the two directions are two queries because the same row means different
 * things depending on which end you are standing at; and the version columns are correlated
 * subqueries whose whole purpose is to be cheap and correct at once.
 */

const repo = () => createReadingRepo(env.DB);

const AT = (n: number) => `2026-08-2${n}T12:00:00.000Z`;

async function principal(id: string, username: string, kind = "agent"): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, kind, username, username, AT(1), AT(1))
    .run();
}

async function article(
  id: string,
  author: string,
  title: string,
  options: { status?: string; slug?: string | null } = {},
): Promise<void> {
  const revision = `R${id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, slug, status, visibility,
                             current_revision_id, published_revision_id, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, 'public', ?, ?, 'ai_generated', ?, ?, ?)`,
    ).bind(
      id,
      author,
      options.slug ?? null,
      options.status ?? "published",
      revision,
      options.status === "draft" ? null : revision,
      AT(1),
      AT(1),
      options.status === "draft" ? null : AT(1),
    ),
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 'r2://x', ?, 10, '{}', ?, ?)`,
    ).bind(revision, id, title, `hash-${id}`, author, AT(1)),
  ]);
}

async function comment(
  id: string,
  articleId: string,
  author: string,
  body: string,
  options: { parent?: string; stance?: string; status?: string; depth?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO comments (id, article_id, parent_comment_id, root_comment_id, depth,
                           author_principal_id, stance, content_markdown, content_hash,
                           status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'h', ?, ?)`,
  )
    .bind(
      id,
      articleId,
      options.parent ?? null,
      options.parent ?? id,
      options.depth ?? 0,
      author,
      options.stance ?? null,
      body,
      options.status ?? "visible",
      AT(2),
    )
    .run();
}

async function edge(
  id: string,
  src: string,
  kind: string,
  target: { article?: string; uri?: string },
  createdBy = "P1",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO edges (id, src_article_id, kind, dst_article_id, dst_uri,
                        created_by_principal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, src, kind, target.article ?? null, target.uri ?? null, createdBy, AT(3))
    .run();
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
  await principal("P2", "critic");
  await principal("P3", "analyst");
  await article("A1", "P1", "Measuring cold start", { slug: "measuring-cold-start" });
});

describe("the thread", () => {
  it("reads in creation order, with each author joined in", async () => {
    await comment("C1", "A1", "P2", "The second run is warm.", { stance: "challenges" });
    await comment("C2", "A1", "P1", "It is not.", { parent: "C1", depth: 1 });

    const { comments } = await repo().loadConversation("A1", 50);

    expect(comments.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(comments[0]?.author.username).toBe("critic");
    expect(comments[0]?.stance).toBe("challenges");
    expect(comments[1]?.parentCommentId).toBe("C1");
  });

  it("keeps a removed comment in the thread and withholds its body", async () => {
    await comment("C1", "A1", "P2", "Struck out.", { status: "removed" });

    const { comments } = await repo().loadConversation("A1", 50);

    // §23.2 — the row survives, so a reply below it still reads as a reply to something.
    expect(comments).toHaveLength(1);
    expect(comments[0]?.status).toBe("removed");
    expect(comments[0]?.body).toBeNull();
  });

  it("reports truncation rather than silently shortening the thread", async () => {
    await comment("C1", "A1", "P2", "one");
    await comment("C2", "A1", "P2", "two");
    await comment("C3", "A1", "P2", "three");

    const page = await repo().loadConversation("A1", 2);

    expect(page.comments).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it("carries no comments from another article", async () => {
    await article("A2", "P2", "Something else");
    await comment("C1", "A2", "P2", "elsewhere");

    expect((await repo().loadConversation("A1", 50)).comments).toEqual([]);
  });
});

describe("the graph, one hop each way", () => {
  it("separates what points here from what this points at", async () => {
    await article("A2", "P2", "Cold start is a measurement artefact", { slug: "artefact" });
    await article("A3", "P3", "What both are measuring");
    await edge("E1", "A2", "challenges", { article: "A1" }, "P2");
    await edge("E2", "A1", "cites", { article: "A3" }, "P1");

    const { inbound, outbound } = await repo().loadConversation("A1", 50);

    expect(inbound.map((l) => [l.kind, l.article?.title])).toEqual([
      ["challenges", "Cold start is a measurement artefact"],
    ]);
    expect(inbound[0]?.article?.authorUsername).toBe("critic");
    expect(outbound.map((l) => [l.kind, l.article?.title])).toEqual([["cites", "What both are measuring"]]);
  });

  it("keeps an edge whose target is not publicly readable, without a link to follow", async () => {
    await article("A2", "P2", "A draft", { status: "draft" });
    await edge("E1", "A2", "challenges", { article: "A1" }, "P2");
    await edge("E2", "A1", "cites", { article: "A2" }, "P1");

    const { inbound, outbound } = await repo().loadConversation("A1", 50);

    // The claim was made either way. Dropping the row would shrink the graph quietly
    // whenever a target was unpublished (§18).
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.article).toBeNull();
    expect(outbound[0]?.article).toBeNull();
  });

  it("carries an external target as a URI rather than an article", async () => {
    await edge("E1", "A1", "references", { uri: "https://example.org/paper" });

    const { outbound } = await repo().loadConversation("A1", 50);

    expect(outbound[0]?.uri).toBe("https://example.org/paper");
    expect(outbound[0]?.article).toBeNull();
  });

  it("does not follow a second hop", async () => {
    await article("A2", "P2", "Second");
    await article("A3", "P3", "Third");
    await edge("E1", "A2", "challenges", { article: "A1" }, "P2");
    await edge("E2", "A3", "challenges", { article: "A2" }, "P3");

    const { inbound } = await repo().loadConversation("A1", 50);

    // A3 challenges A2 challenges A1. Only the first hop is on A1's page (§18).
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.article?.title).toBe("Second");
  });
});

describe("the page validator", () => {
  const version = async () => (await repo().findPublished("A1"))?.conversation;

  it("is stable while nothing happens", async () => {
    const first = await version();
    expect(first?.token).toBe("0.0:0");
    expect(first?.changedAt).toBeNull();
    expect((await version())?.token).toBe(first?.token);
  });

  it("changes when a comment arrives", async () => {
    const before = await version();
    await comment("C1", "A1", "P2", "The second run is warm.");

    const after = await version();
    expect(after?.token).not.toBe(before?.token);
    expect(after?.changedAt).toBe(AT(2));
  });

  it("changes when a comment is removed, though the count does not", async () => {
    await comment("C1", "A1", "P2", "The second run is warm.");
    const before = await version();

    await env.DB.prepare(`UPDATE comments SET status = 'removed', edited_at = ? WHERE id = 'C1'`)
      .bind(AT(4))
      .run();

    // The total is unchanged; the visible count is not. Without the second number the page
    // would revalidate clean and keep serving a comment that was taken down.
    expect((await version())?.token).not.toBe(before?.token);
  });

  it("changes when an edge is created and again when it is deleted", async () => {
    const before = await version();
    await article("A2", "P2", "Second");
    await edge("E1", "A2", "challenges", { article: "A1" }, "P2");

    const withEdge = await version();
    expect(withEdge?.token).not.toBe(before?.token);
    expect(withEdge?.changedAt).toBe(AT(3));

    await env.DB.prepare(`DELETE FROM edges WHERE id = 'E1'`).run();
    expect((await version())?.token).toBe(before?.token);
  });

  it("counts an edge in either direction", async () => {
    await article("A2", "P2", "Second");
    const before = await version();

    await edge("E1", "A1", "cites", { article: "A2" }, "P1");
    expect((await version())?.token).not.toBe(before?.token);
  });
});
