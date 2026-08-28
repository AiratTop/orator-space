import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createModerationRepo } from "./moderation.js";

/**
 * What the review queue says each report is about (SPEC §61.1).
 *
 * Against a real database because the interesting cases are joins that a double gets right by
 * construction: a title read through `published_revision_id` with a fallback to the current
 * one, and a target row that is not there at all. The queue was unusable without this — fifty
 * lines of `article 06G2G3ZB8N…` — and the failure mode of getting it wrong is a moderator
 * acting on the wrong article, which no test after the fact can undo.
 */

const repo = () => createModerationRepo(env.DB);
const AT = "2026-08-20T12:00:00.000Z";

async function principal(id: string, username: string, displayName: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO principals (id, kind, username, username_skeleton, display_name, created_at, updated_at)
     VALUES (?, 'human', ?, ?, ?, ?, ?)`,
  )
    .bind(id, username, username, displayName, AT, AT)
    .run();
}

async function article(id: string, author: string, title: string, published = true) {
  const revision = `R${id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility, current_revision_id,
                             published_revision_id, authorship_disclosure, created_at, updated_at)
       VALUES (?, ?, ?, 'public', ?, ?, 'human_authored', ?, ?)`,
    ).bind(id, author, published ? "published" : "draft", revision, published ? revision : null, AT, AT),
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, ?, 'r2://x', ?, 10, '{}', ?, ?)`,
    ).bind(revision, id, title, `hash-${id}`, author, AT),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM comments`),
    env.DB.prepare(`DELETE FROM revisions`),
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
  await principal("AUTHOR", "author", "The Author");
  await article("ART", "AUTHOR", "Cold start latency, measured");
});

describe("what a report is about", () => {
  it("names an article by its title", async () => {
    const [summary] = await repo().describeTargets([{ targetType: "article", targetId: "ART" }]);
    expect(summary?.label).toBe("Cold start latency, measured");
    expect(summary?.articleId).toBe("ART");
  });

  it("still names an article that has never been published", async () => {
    // The ordinary case for a report is an article somebody has already hidden, which has no
    // published revision. A queue that cannot say which article that was is worked with two
    // tabs open, which is how the wrong one gets actioned.
    await article("DRAFT", "AUTHOR", "Not out yet", false);
    const [summary] = await repo().describeTargets([{ targetType: "article", targetId: "DRAFT" }]);
    expect(summary?.label).toBe("Not out yet");
  });

  it("names a comment by its opening words, and the article it is on", async () => {
    await env.DB.prepare(
      `INSERT INTO comments (id, article_id, depth, author_principal_id, content_markdown,
                             content_hash, status, created_at)
       VALUES ('C1', 'ART', 0, 'AUTHOR', ?, 'h1', 'visible', ?)`,
    )
      .bind("The measurement is wrong and here is why: ".repeat(8), AT)
      .run();

    const [summary] = await repo().describeTargets([{ targetType: "comment", targetId: "C1" }]);
    expect(summary?.label).toMatch(/^The measurement is wrong/);
    // Cut in SQL rather than in the Worker: a comment may be the whole of §16.2's allowance.
    expect(summary?.label?.length).toBe(120);
    expect(summary?.articleId).toBe("ART");
  });

  it("names a principal, and prefers the name over the handle", async () => {
    const [summary] = await repo().describeTargets([{ targetType: "principal", targetId: "AUTHOR" }]);
    expect(summary?.label).toBe("The Author");
  });

  it("returns a line for a target that is gone rather than dropping it", async () => {
    // §23.3 erases; the report stays open and the queue still has to render it. Dropping the
    // row here would make a report vanish from the page while remaining in the table.
    const summaries = await repo().describeTargets([
      { targetType: "article", targetId: "ART" },
      { targetType: "article", targetId: "NOTHING" },
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries[1]?.label).toBeNull();
  });

  it("asks nothing when there is nothing to ask about", async () => {
    expect(await repo().describeTargets([])).toEqual([]);
  });
});
