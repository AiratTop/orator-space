import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Database } from "./database.js";
import { createEmbeddingLedger } from "./embeddings.js";

/**
 * The backlog drain's predicate, against a real database (§38.2, §35.2, migration 0023).
 *
 * Here rather than only against the in-memory double, because the defect this file exists to
 * prevent was in the SQL and nowhere else. The predicate selected on two conditions while a
 * comment above it described three, so an article whose `article.updated` event was lost kept
 * a vector built from the previous text permanently — and every unit test passed, because the
 * double implemented the three conditions the comment claimed.
 *
 * A double written from the same misunderstanding as the code agrees with it. This does not.
 */

const ledger = () => createEmbeddingLedger(env.DB);
const db = () => createD1Database(env.DB);
const AT = "2026-08-29T12:00:00.000Z";
const MODEL = "workers-ai:test";

async function article(id: string, revisionId: string, options: { duplicateOf?: string } = {}) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, created_at, updated_at)
       VALUES ('P1', 'agent', 'researcher', 'researcher', ?, ?)`,
    ).bind(AT, AT),
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility, authorship_disclosure,
                             created_at, updated_at, published_at, published_revision_id, duplicate_of)
       VALUES (?, 'P1', 'published', 'public', 'ai_generated', ?, ?, ?, ?, ?)`,
    ).bind(id, AT, AT, AT, revisionId, options.duplicateOf ?? null),
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, 'A title', 'r2://x', 'hash-1', 10, '{"schema_version":1}', 'P1', ?)`,
    ).bind(revisionId, id, AT),
  ]);
}

/** Moves the article to a new revision without telling the ledger — a lost event. */
async function republish(id: string, revisionId: string) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO revisions (id, article_id, title, content_ref, content_hash, content_bytes,
                              metadata_json, created_by_principal_id, created_at)
       VALUES (?, ?, 'Another title', 'r2://x', 'hash-1', 10, '{"schema_version":1}', 'P1', ?)`,
    ).bind(revisionId, id, AT),
    env.DB.prepare(`UPDATE articles SET published_revision_id = ? WHERE id = ?`).bind(revisionId, id),
  ]);
}

const embedded = (articleId: string, revisionId: string | null, model = MODEL) =>
  db().commit([
    ledger().record({
      articleId,
      inputHash: "input-1",
      revisionId,
      model,
      dimensions: 1024,
      embeddedAt: AT,
    }),
  ]);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM article_embeddings`),
    env.DB.prepare(`DELETE FROM revisions`),
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
});

describe("what the drain considers stale", () => {
  it("an article nothing has embedded", async () => {
    await article("A1", "REV-1");
    expect(await ledger().listStale(MODEL, 10)).toEqual(["A1"]);
  });

  it("not one embedded from the revision that is published", async () => {
    await article("A1", "REV-1");
    await embedded("A1", "REV-1");
    expect(await ledger().listStale(MODEL, 10)).toEqual([]);
  });

  /*
   * The gap migration 0023 closed, in the one place it was open.
   *
   * No event is delivered here, which is the point: five failed deliveries send a message to
   * the dead-letter queue and nothing else ever mentions this article again. Before 0023 the
   * predicate had no way to notice, and the vector stayed built from the previous text.
   */
  it("one whose published revision has moved since it was embedded", async () => {
    await article("A1", "REV-1");
    await embedded("A1", "REV-1");
    await republish("A1", "REV-2");

    expect(await ledger().listStale(MODEL, 10)).toEqual(["A1"]);
    expect(await ledger().countStale(MODEL, 100)).toBe(1);
  });

  it("one embedded by a model that is no longer in use", async () => {
    await article("A1", "REV-1");
    await embedded("A1", "REV-1", "workers-ai:previous");
    expect(await ledger().listStale(MODEL, 10)).toEqual(["A1"]);
  });

  /*
   * A row written by migration 0022, which recorded no revision at all.
   *
   * Selected once so it can be settled. `embedArticle` writes the revision without calling a
   * model when the text has not moved — without that, this row would be selected on every run
   * for ever, which is a drain that cannot mark anything as caught.
   */
  it("one whose row names no revision, until the row names one", async () => {
    await article("A1", "REV-1");
    await embedded("A1", null);
    expect(await ledger().listStale(MODEL, 10)).toEqual(["A1"]);

    await embedded("A1", "REV-1");
    expect(await ledger().listStale(MODEL, 10)).toEqual([]);
  });

  it("never a duplicate, whatever else is true of it", async () => {
    await article("A1", "REV-1");
    await article("A2", "REV-9", { duplicateOf: "A1" });
    expect(await ledger().listStale(MODEL, 10)).toEqual(["A1"]);
  });

  it("reads back what it recorded, revision included", async () => {
    await article("A1", "REV-1");
    await embedded("A1", "REV-1");
    expect(await ledger().find("A1")).toEqual({
      inputHash: "input-1",
      revisionId: "REV-1",
      model: MODEL,
      dimensions: 1024,
    });
  });

  it("forgets an article entirely", async () => {
    await article("A1", "REV-1");
    await embedded("A1", "REV-1");
    await db().commit([ledger().forget("A1")]);
    expect(await ledger().find("A1")).toBeNull();
  });
});
