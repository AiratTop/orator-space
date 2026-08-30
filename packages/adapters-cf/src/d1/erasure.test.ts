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
  // The bucket persists between tests in one worker, and the listing tests read all of it.
  const { objects } = await content().list({ limit: 1000 });
  await content().deleteMany(objects.map((object) => object.contentHash));
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

describe("the orphan collector's question (§32.2)", () => {
  it("names the hashes a live revision still points at, and only those", async () => {
    const gone = await revision("A1", "R1", "# Gone\n\nBody.\n");
    const kept = await revision("A2", "R2", "# Kept\n\nBody.\n");
    await env.DB.batch([repo().eraseRevisionsOf("A1", AT) as never]);

    const live = await repo().liveContentHashes([gone, kept]);
    expect(live.has(kept)).toBe(true);
    expect(live.has(gone)).toBe(false);
  });

  it("says nothing is live about a hash it has never seen", async () => {
    // The object written before a commit that failed: no row, no `content_hash`, and the
    // old query over `revisions` could not have returned it at all. This is the direction
    // that can — the collector enumerates the store and asks about what it found.
    const orphan = await content().put("# Never committed\n\nBody.\n");
    expect((await repo().liveContentHashes([orphan])).size).toBe(0);
    expect(await content().get(orphan)).not.toBeNull();
  });

  it("takes an empty list without asking the database", async () => {
    expect((await repo().liveContentHashes([])).size).toBe(0);
  });

  it("answers a full chunk in one query", async () => {
    const hashes: string[] = [];
    for (let n = 0; n < 90; n += 1) {
      hashes.push(await revision("A1", `R${String(n).padStart(3, "0")}`, `# Body ${n}\n\nUnique.\n`));
    }

    const live = await repo().liveContentHashes(hashes);
    expect(live.size).toBe(90);
  });
});

describe("the store's own listing (§32.2)", () => {
  it("lists what is there, with the timestamps the grace period reads", async () => {
    const hash = await content().put("# Listed\n\nBody.\n");
    const page = await content().list({ limit: 10 });

    const found = page.objects.find((object) => object.contentHash === hash);
    expect(found).toBeDefined();
    expect(found?.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pages, and a deleted object is simply gone from the next listing", async () => {
    // This is the collector's progress: not a cursor it has to persist between cron runs,
    // and not a column marking what it did, but the absence of what it collected.
    const hashes = [];
    for (let n = 0; n < 5; n += 1) hashes.push(await content().put(`# Body ${n}\n\nUnique.\n`));

    const before = await content().list({ limit: 100 });
    expect(before.objects.length).toBeGreaterThanOrEqual(5);

    await content().deleteMany(hashes);

    const after = await content().list({ limit: 100 });
    for (const hash of hashes) {
      expect(after.objects.some((object) => object.contentHash === hash), hash).toBe(false);
    }
  });

  it("deletes a whole erasure's worth of bodies in one call", async () => {
    const hashes = [];
    for (let n = 0; n < 250; n += 1) hashes.push(await content().put(`# Body ${n}\n\nUnique.\n`));

    await content().deleteMany(hashes);

    for (const hash of hashes.slice(0, 5)) expect(await content().get(hash)).toBeNull();
    expect(await content().get(hashes.at(-1)!)).toBeNull();
  });
});
