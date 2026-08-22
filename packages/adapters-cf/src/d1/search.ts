import type { SearchDocument, SearchIndex } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";

/**
 * FTS5 over D1 (SPEC §38.1).
 *
 * The table is contentless: it holds the inverted index and none of the text. That is what
 * reconciles §38.1's wish for an external-content table with §16.2's decision to keep
 * bodies in R2 — an external-content table reads from a SQLite table, and there is no such
 * table to read from. A contentless one needs no source at all.
 *
 * Writes here are not part of any transaction. That is the point (§38.1): a failing index
 * must not fail a publish, and this runs in the queue consumer where a retry is free.
 */

/**
 * Escapes a user query into an FTS5 MATCH expression.
 *
 * FTS5's query syntax is a language — `NEAR`, `*`, `^`, `OR`, column filters — and a raw
 * user string is either a syntax error or an unintended operator. Every term is quoted, so
 * what an agent types is searched for rather than executed.
 */
export function toMatchExpression(text: string): string | null {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 0 && term.length <= 64)
    .slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" ");
}

export function createSearchIndex(db: D1Database): SearchIndex {
  return {
    async index(document: SearchDocument, at: string) {
      const existing = await db
        .prepare(`SELECT doc_id FROM search_docs WHERE article_id = ?`)
        .bind(document.articleId)
        .first<{ doc_id: number }>();

      const docId =
        existing?.doc_id ??
        (
          await db
            .prepare(
              `INSERT INTO search_docs (article_id, content_hash, indexed_at) VALUES (?, ?, ?)
               RETURNING doc_id`,
            )
            .bind(document.articleId, document.contentHash, at)
            .first<{ doc_id: number }>()
        )?.doc_id;

      if (docId === undefined) throw new Error("could not allocate a search document id");

      // Delete then insert: FTS5 has no upsert, and a contentless table cannot be updated
      // in place. Two statements in one batch, so a partial application is not possible.
      await db.batch([
        db.prepare(`DELETE FROM article_fts WHERE rowid = ?`).bind(docId),
        db
          .prepare(
            `INSERT INTO article_fts (rowid, title, excerpt, body, author, topics)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(docId, document.title, document.excerpt, document.body, document.author, document.topics),
        db
          .prepare(`UPDATE search_docs SET content_hash = ?, indexed_at = ? WHERE doc_id = ?`)
          .bind(document.contentHash, at, docId),
      ]);
    },

    async remove(articleId: string) {
      const existing = await db
        .prepare(`SELECT doc_id FROM search_docs WHERE article_id = ?`)
        .bind(articleId)
        .first<{ doc_id: number }>();
      if (existing === null) return;

      await db.batch([
        db.prepare(`DELETE FROM article_fts WHERE rowid = ?`).bind(existing.doc_id),
        db.prepare(`DELETE FROM search_docs WHERE doc_id = ?`).bind(existing.doc_id),
      ]);
    },

    async indexedHash(articleId: string) {
      const row = await db
        .prepare(`SELECT content_hash FROM search_docs WHERE article_id = ?`)
        .bind(articleId)
        .first<{ content_hash: string }>();
      return row?.content_hash ?? null;
    },

    async query(text: string, limit: number) {
      const expression = toMatchExpression(text);
      if (expression === null) return [];

      // Joined back to `articles` rather than trusted on its own: the index is derived data
      // and may lag a withdrawal by one event, so the live status decides what is returned.
      const { results } = await db
        .prepare(
          `SELECT d.article_id AS id
             FROM article_fts f
             JOIN search_docs d ON d.doc_id = f.rowid
             JOIN articles a    ON a.id = d.article_id
            WHERE f MATCH ?
              AND a.status = 'published' AND a.visibility = 'public'
            ORDER BY f.rank
            LIMIT ?`,
        )
        .bind(expression, limit)
        .all<{ id: string }>();
      return results.map((row) => row.id as OratorId);
    },
  };
}
