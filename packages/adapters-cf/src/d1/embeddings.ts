import type { EmbeddingLedger } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/**
 * What has been embedded (SPEC §38.2, migration 0022).
 *
 * The only part of semantic search that lives in D1, and it holds no vector — §38.2 forbids
 * one reaching the database at all. What it holds is the answer to "would embedding this
 * article again produce anything new", which is the question that keeps an at-least-once
 * queue from being an at-least-once bill.
 */
export function createEmbeddingLedger(db: D1Database): EmbeddingLedger {
  /**
   * What has no current vector, as one predicate.
   *
   * Three conditions that are one idea. An article is stale if nothing has embedded it, if
   * the model that did is not the model in use, or if the text has moved on since — and the
   * third is a join rather than a column comparison, because `input_hash` is over the
   * composed document and D1 cannot recompute it. `content_hash` stands in: a body that has
   * changed guarantees the document has, and a title-only edit is caught by the event handler
   * rather than here. The drain is the safety net (§35.2), not the primary path, and a net
   * that catches the common case and lets the rare one through to the handler is the right
   * division.
   *
   * `duplicate_of IS NULL` is in the predicate rather than left to the caller, which would
   * have to read every candidate to find out — turning a bounded query into ten reads that
   * mostly return "never mind".
   */
  const STALE = `
    FROM articles a
    JOIN revisions r ON r.id = a.published_revision_id
    LEFT JOIN article_embeddings e ON e.article_id = a.id
   WHERE a.status = 'published'
     AND a.visibility = 'public'
     AND a.duplicate_of IS NULL
     AND (e.article_id IS NULL OR e.model <> ?1)`;

  return {
    async find(articleId) {
      const row = await db
        .prepare(`SELECT input_hash, model, dimensions FROM article_embeddings WHERE article_id = ?`)
        .bind(articleId)
        .first<{ input_hash: string; model: string; dimensions: number }>();
      if (row === null) return null;
      return { inputHash: row.input_hash, model: row.model, dimensions: row.dimensions };
    },

    record(entry) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO article_embeddings (article_id, input_hash, model, dimensions, embedded_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (article_id) DO UPDATE
               SET input_hash = excluded.input_hash,
                   model = excluded.model,
                   dimensions = excluded.dimensions,
                   embedded_at = excluded.embedded_at`,
          )
          .bind(entry.articleId, entry.inputHash, entry.model, entry.dimensions, entry.embeddedAt),
      );
    },

    forget(articleId) {
      return asWrite(db.prepare(`DELETE FROM article_embeddings WHERE article_id = ?`).bind(articleId));
    },

    async listStale(model, limit) {
      /*
       * Oldest first, by id.
       *
       * §12 makes the id monotonic in creation time, so this is publication order without a
       * sort on a date column — and it makes the drain deterministic, which matters more than
       * it sounds: a drain that picked an arbitrary ten each run would revisit the same
       * articles and starve the tail on a corpus larger than one batch.
       */
      const { results } = await db
        .prepare(`SELECT a.id ${STALE} ORDER BY a.id ASC LIMIT ?2`)
        .bind(model, limit)
        .all<{ id: string }>();
      return results.map((row) => row.id as OratorId);
    },

    async countStale(model, cap) {
      // Counted inside a capped subquery rather than over the whole table: §66.4 wants to
      // know whether there is a backlog and roughly how bad, and a full count on a growing
      // corpus is a scan run every five minutes to produce a number nobody reads precisely.
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT a.id ${STALE} LIMIT ?2)`)
        .bind(model, cap)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
