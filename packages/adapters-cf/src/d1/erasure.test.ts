import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createArticleRepo } from "./articles.js";
import { createR2ContentStore } from "../content-store.js";

/**
 * §23.3 and §32.2 against a real database and a real bucket (SPEC §68).
 *
 * The domain tests cover the decisions; these cover the two things a memory double cannot
 * have an opinion about. The reference check is one `GROUP BY` with a correlated subquery
 * and a conditional sum — the kind of SQL that is either right or silently returns the wrong
 * number — and the deletion is an R2 call whose key shape is the adapter's own business.
 *
 * The scale case is here for the same reason. The check used to be a `COUNT(*)` per distinct
 * body, which a double answers instantly and a database answers once per round trip.
 */

const repo = () => createArticleRepo(env.DB);
const content = () => createR2ContentStore(env.CONTENT as R2Bucket);
const AT = "2026-08-31T12:00:00.000Z";

async function principal(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, system_account, created_at, updated_at)
     VALUES (?, 'agent', ?, ?, 0, ?, ?)`,
  )
    .bind(id, `u-${id}`, `u-${id}`, AT, AT)
    .run();
}

async function article(id: string): Promise<void> {
  await principal("P0000000000000000000000000");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO articles
       (id, author_principal_id, language, authorship_disclosure, visibility, status, created_at, updated_at)
     VALUES (?, 'P0000000000000000000000000', 'en', 'human_authored', 'public', 'published', ?, ?)`,
  )
    .bind(id, AT, AT)
    .run();
}

/** A revision of `articleId` holding `markdown`, with the body actually in the bucket. */
async function revision(articleId: string, revisionId: string, markdown: string): Promise<string> {
  await article(articleId);
  const hash = await content().put(markdown);
  await env.DB.prepare(
    `INSERT INTO revisions
       (id, article_id, parent_revision_id, title, excerpt, content_ref, content_hash,
        content_bytes, reading_time_seconds, metadata_json, created_by_principal_id, created_at)
     VALUES (?, ?, NULL, 'A title', NULL, ?, ?, ?, 1, '{"schema_version":1}',
             'P0000000000000000000000000', ?)`,
  )
    .bind(revisionId, articleId, content().refFor(hash), hash, markdown.length, AT)
    .run();
  return hash;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM revisions").run();
  await env.DB.prepare("DELETE FROM articles").run();
});

describe("the reference check, in SQL (§23.3)", () => {
  it("counts this article's revisions and the live ones elsewhere", async () => {
    const body = "# Shared\n\nSame bytes.\n";
    await revision("A1", "R1", body);
    await revision("A1", "R2", body);
    await revision("A2", "R3", body);

    const [row] = await repo().contentReferences("A1");
    expect(row?.mine).toBe(2);
    expect(row?.elsewhere).toBe(1);
  });

  it("stops counting a revision whose pointer has been blanked", async () => {
    // The defect this replaced: §23.3 keeps `content_hash` on an erased revision as the
    // trace, so counting rows rather than live pointers made a shared body undeletable
    // forever once the first of its articles had been erased.
    const body = "# Shared\n\nSame bytes.\n";
    await revision("A1", "R1", body);
    await revision("A2", "R2", body);

    await env.DB.batch([repo().eraseRevisionsOf("A2", AT) as never]);

    const [row] = await repo().contentReferences("A1");
    expect(row?.elsewhere).toBe(0);
  });

  it("blanks an entire history in one statement, whatever its length", async () => {
    for (let n = 0; n < 250; n += 1) {
      await revision("A1", `R${String(n).padStart(3, "0")}`, `# Body ${n}\n\nUnique.\n`);
    }

    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);

    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM revisions WHERE article_id = 'A1' AND content_ref = ''`,
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(250);
  });

  it("answers 250 distinct bodies in one query, not one query each", async () => {
    for (let n = 0; n < 250; n += 1) {
      await revision("A1", `R${String(n).padStart(3, "0")}`, `# Body ${n}\n\nUnique.\n`);
    }

    const rows = await repo().contentReferences("A1");
    expect(rows).toHaveLength(250);
    expect(rows.every((row) => row.mine === 1 && row.elsewhere === 0)).toBe(true);
  });
});

describe("the orphan collector's input (§32.2)", () => {
  it("returns a body no live revision points at", async () => {
    const hash = await revision("A1", "R1", "# Gone\n\nBody.\n");
    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);

    expect(await repo().listUnreferencedContent(10)).toEqual([hash]);
  });

  it("does not return one that is still referenced anywhere", async () => {
    const body = "# Shared\n\nSame bytes.\n";
    await revision("A1", "R1", body);
    await revision("A2", "R2", body);
    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);

    expect(await repo().listUnreferencedContent(10)).toEqual([]);
  });

  it("returns it once the last reference goes, and the object then deletes", async () => {
    // The sequence §23.3 leaves behind: two erasures, neither of which may delete the
    // object, and a store that has to end up empty regardless. End to end, on real R2.
    const body = "# Shared\n\nSame bytes.\n";
    const hash = await revision("A1", "R1", body);
    await revision("A2", "R2", body);

    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);
    expect(await repo().listUnreferencedContent(10)).toEqual([]);
    expect(await content().get(hash)).toBe(body);

    await env.DB.batch([repo().eraseRevisionsOf("A2", AT) as never]);
    expect(await repo().listUnreferencedContent(10)).toEqual([hash]);

    await content().delete(hash);
    expect(await content().get(hash)).toBeNull();
  });

  it("respects its limit, so a backlog is drained in passes", async () => {
    for (let n = 0; n < 5; n += 1) {
      await revision("A1", `R${n}`, `# Body ${n}\n\nUnique.\n`);
    }
    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);

    expect(await repo().listUnreferencedContent(2)).toHaveLength(2);
    expect(await repo().listUnreferencedContent(10)).toHaveLength(5);
  });
});
