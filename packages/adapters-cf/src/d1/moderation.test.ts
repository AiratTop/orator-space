import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createModerationRepo } from "./moderation.js";
import { createD1Database } from "./database.js";

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

/**
 * Which end of the queue, and how deep it is (SPEC §61.1, §44.2).
 *
 * Here rather than only against the double because a keyset cursor running backwards is the
 * class of bug that does not throw: pair `ORDER BY id DESC` with `id > ?` and every "next"
 * returns the page just read. The double can be made to agree with either, so the SQL is
 * what has to be asked.
 */
/**
 * The address a queue line points at (SPEC §61.1, §7.3).
 *
 * The label and the address are different things and the page had only the label, so it
 * recovered the handle by parsing `display_name ?? "@" + username`. That linked correctly for
 * a principal with no display name and nowhere for one who had set it — a link on the queue
 * that reloaded the queue.
 */
describe("what a queue line can be linked to", () => {
  it("carries a principal's handle beside the name it displays", async () => {
    await principal("NAMED", "the-agent", "The Agent");
    const [summary] = await repo().describeTargets([{ targetType: "principal", targetId: "NAMED" }]);
    expect(summary?.label).toBe("The Agent");
    expect(summary?.username).toBe("the-agent");
  });

  it("and does so when there is no display name to hide it", async () => {
    await principal("PLAIN", "plain-agent");
    const [summary] = await repo().describeTargets([{ targetType: "principal", targetId: "PLAIN" }]);
    expect(summary?.label).toBe("@plain-agent");
    expect(summary?.username).toBe("plain-agent");
  });

  it("describes a target that is gone with nothing to link to, rather than dropping the line", async () => {
    const [summary] = await repo().describeTargets([
      { targetType: "principal", targetId: "06GXXXXXXXXXXXXXXXXXXXXXXX" },
    ]);
    expect(summary?.label).toBeNull();
    expect(summary?.username).toBeNull();
  });
});

describe("the order the queue is read in", () => {
  const db = () => createD1Database(env.DB);

  const file = (id: string, category: string) =>
    repo().insertReport({
      id: id as never,
      targetType: "article",
      targetId: "ART",
      reporterPrincipalId: null,
      reporterContact: null,
      category: category as never,
      details: null,
      createdAt: AT,
    });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM reports");
    await db().commit([file("R1", "spam"), file("R2", "abuse"), file("R3", "other")]);
  });

  const open = { status: ["open"] as const, targetType: null };

  it("walks oldest first by default", async () => {
    const page = await repo().listReports({ ...open, limit: 10, after: null });
    expect(page.map((report) => report.id)).toEqual(["R1", "R2", "R3"]);
  });

  it("walks newest first when asked", async () => {
    const page = await repo().listReports({ ...open, order: "newest", limit: 10, after: null });
    expect(page.map((report) => report.id)).toEqual(["R3", "R2", "R1"]);
  });

  it("pages backwards without repeating the page it just returned", async () => {
    const first = await repo().listReports({ ...open, order: "newest", limit: 1, after: null });
    expect(first.map((report) => report.id)).toEqual(["R3"]);

    const second = await repo().listReports({ ...open, order: "newest", limit: 1, after: "R3" });
    expect(second.map((report) => report.id)).toEqual(["R2"]);
  });

  it("counts what matches, not what is on the page", async () => {
    expect(await repo().countReports(open)).toBe(3);
    expect(await repo().countReports({ status: ["actioned"], targetType: null })).toBe(0);
  });

  /*
   * §61.1 — the filter that makes a deep queue workable, and the count that must agree.
   *
   * A number beside a page has to describe that page's population. Built from one `WHERE`
   * for both, because written twice they agree until somebody adds a filter to one — and the
   * symptom is a heading saying fifty of five hundred above eleven rows.
   */
  it("filters by what the report is about, and counts the same population", async () => {
    await db().commit([
      repo().insertReport({
        id: "R4" as never,
        targetType: "principal",
        targetId: "AUTHOR",
        reporterPrincipalId: null,
        reporterContact: null,
        category: "abuse" as never,
        details: null,
        createdAt: AT,
      }),
    ]);

    const accounts = { status: ["open"] as const, targetType: "principal" as const };
    expect((await repo().listReports({ ...accounts, limit: 10, after: null })).map((r) => r.id)).toEqual(["R4"]);
    expect(await repo().countReports(accounts)).toBe(1);
    expect(await repo().countReports(open)).toBe(4);
  });

  it("takes several statuses at once, which is what the queue is", async () => {
    await db().commit([
      repo().setReportStatus("R2", "reviewing", ["open"], "AUTHOR" as never, null, AT),
    ]);
    const queue = { status: ["open", "reviewing"] as const, targetType: null };
    expect((await repo().listReports({ ...queue, limit: 10, after: null })).map((r) => r.id)).toEqual([
      "R1",
      "R2",
      "R3",
    ]);
    expect(await repo().countReports(queue)).toBe(3);
  });
});
