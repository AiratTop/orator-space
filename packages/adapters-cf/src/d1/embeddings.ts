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
   * Three conditions that are one idea, and the one idea is what the negation says: nothing
   * here holds a vector for this article, made by the model in use, from the revision that is
   * published now. `NOT EXISTS` is that sentence; the disjunction it replaced — no row, or
   * another model, or no revision recorded, or a different one — was the same set spelled out
   * a case at a time, and every case had to be got right separately. The middle one was
   * missing until migration 0023, and its absence was the whole gap: a lost `article.updated`
   * event left a vector stale permanently, because no further event was coming and this query
   * could not see it. That is exactly what a safety net is for (§35.2), and a net described as
   * covering a case it does not cover is worse than one with a stated limit, because the
   * argument for having no backfill script rests on it.
   *
   * A row written before 0023 records no revision, and `e.revision_id = a.published_revision_id`
   * is not true of NULL — so those rows are still selected, exactly once. The service then
   * writes the row without calling a model when the text has not moved, which is what stops
   * that single pass becoming a loop.
   *
   * `revision_id` and not a body hash. The ledger's exact key is `input_hash`, over the
   * composed document, which D1 has no way to recompute. A body hash would stand in for most
   * edits and miss the one this feature was built around — editing a title makes a new revision
   * carrying the *same* body. A revision id moves whenever any field does.
   *
   * The division of labour stays: coarse and free here, exact and paid in the service. A
   * revision whose text lands identically inside the model's window is selected by this query,
   * found unchanged by `embedArticle`, and costs an R2 read rather than an inference call.
   *
   * `duplicate_of IS NULL` is in the predicate rather than left to the caller, which would
   * have to read every candidate to find out — turning a bounded query into ten reads that
   * mostly return "never mind".
   *
   * No join to `revisions` (migration 0027). It read `r.id = a.published_revision_id` and then
   * compared the ledger against `r.id`, which is that column — so the join asserted that the
   * published revision row exists, at the price of an index probe per article on every run.
   * Revisions are immutable and are never deleted (§16), so the only thing it excluded was an
   * article published with no pointer at all, and `published_revision_id IS NOT NULL` excludes
   * that for nothing.
   */
  const EMBEDDABLE = `
    FROM articles a
   WHERE a.status = 'published'
     AND a.visibility = 'public'
     AND a.duplicate_of IS NULL
     AND a.published_revision_id IS NOT NULL`;

  const CURRENT_VECTOR = `EXISTS (SELECT 1
                                    FROM article_embeddings e
                                   WHERE e.article_id = a.id
                                     AND e.model = ?1
                                     AND e.revision_id = a.published_revision_id)`;

  return {
    async find(articleId) {
      const row = await db
        .prepare(
          `SELECT input_hash, revision_id, model, dimensions FROM article_embeddings WHERE article_id = ?`,
        )
        .bind(articleId)
        .first<{ input_hash: string; revision_id: string | null; model: string; dimensions: number }>();
      if (row === null) return null;
      return {
        inputHash: row.input_hash,
        revisionId: row.revision_id,
        model: row.model,
        dimensions: row.dimensions,
      };
    },

    record(entry) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO article_embeddings
               (article_id, input_hash, revision_id, model, dimensions, embedded_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (article_id) DO UPDATE
               SET input_hash = excluded.input_hash,
                   revision_id = excluded.revision_id,
                   model = excluded.model,
                   dimensions = excluded.dimensions,
                   embedded_at = excluded.embedded_at`,
          )
          .bind(
            entry.articleId,
            entry.inputHash,
            entry.revisionId,
            entry.model,
            entry.dimensions,
            entry.embeddedAt,
          ),
      );
    },

    forget(articleId) {
      return asWrite(db.prepare(`DELETE FROM article_embeddings WHERE article_id = ?`).bind(articleId));
    },

    async scanForStale(model, after, window) {
      /*
       * A window of the corpus in id order, not a list of the stale ones.
       *
       * §12 makes the id monotonic in creation time, so `a.id > ?2` walks the corpus in
       * publication order without sorting a date column, and `ix_articles_embeddable`
       * (migration 0027) serves both the range and the order. The caller keeps the position
       * between invocations, which is what turns a scan of everything into a sweep.
       *
       * The staleness test rides along as a column instead of filtering. That is the whole
       * change: a filter has to keep reading until it has found `limit` stale articles, and
       * on a corpus with none it reads all of them to say so, every five minutes. Returning
       * the window as it is read costs two rows an article and stops at the window's edge,
       * whatever the answers were.
       */
      const { results } = await db
        .prepare(
          `SELECT a.id AS id, NOT ${CURRENT_VECTOR} AS stale ${EMBEDDABLE}
              AND a.id > ?2
            ORDER BY a.id ASC
            LIMIT ?3`,
        )
        .bind(model, after, window)
        .all<{ id: string; stale: number }>();
      return results.map((row) => ({ id: row.id as OratorId, stale: row.stale === 1 }));
    },

    async countStale(model, cap) {
      // Counted inside a capped subquery rather than over the whole table: §66.4 wants to
      // know whether there is a backlog and roughly how bad, and a full count on a growing
      // corpus is a scan to produce a number nobody reads precisely.
      //
      // The drain no longer asks on every run either (migration 0027). It is the one query
      // here that still reads the whole corpus, so it is asked only when the sweep's window
      // came back full of stale articles — that is a backlog worth a number, and next to the
      // inference calls it is about to pay for, one scan is not the expensive part.
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT a.id ${EMBEDDABLE} AND NOT ${CURRENT_VECTOR} LIMIT ?2)`)
        .bind(model, cap)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
