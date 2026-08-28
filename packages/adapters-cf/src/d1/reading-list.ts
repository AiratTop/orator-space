import type { ReadingListRepo } from "@orator/core/ports";
import { asWrite } from "./database.js";
import { cardSelect, toCardRow } from "./reading.js";

/**
 * SPEC §49.2, ADR 0011 — one person's private list, over D1.
 *
 * A duplicate save is a no-op rather than a conflict: somebody pressing the button twice
 * meant it once, and an error would be the platform arguing with them about their own list.
 */
export function createReadingListRepo(db: D1Database): ReadingListRepo {
  return {
    async has(principalId, articleId) {
      const row = await db
        .prepare(`SELECT 1 AS present FROM reading_list WHERE principal_id = ? AND article_id = ?`)
        .bind(principalId, articleId)
        .first<{ present: number }>();
      return row !== null;
    },

    /**
     * Newest first, keyset by article id (§44.2, §12.2).
     *
     * Ordered by the article rather than by when it was saved, which are different orders and
     * the difference is deliberate: a list ordered by saving time re-sorts itself every time
     * somebody adds an old article, and a reader looking for what they saved last week finds
     * it has moved. The article's own id is stable.
     *
     * A saved article that has since been unpublished or removed simply does not join — the
     * list shows what can still be read, and §23.2's tombstone is not something to keep
     * offering somebody.
     */
    async list(principalId, limit, before) {
      const keyset = before === null ? "" : " AND a.id < ?";
      const binds = before === null ? [principalId, limit] : [principalId, before, limit];
      const { results } = await db
        .prepare(
          `${cardSelect()}
             JOIN reading_list rl ON rl.article_id = a.id
            WHERE rl.principal_id = ?
              AND a.status = 'published' AND a.visibility = 'public' AND p.status = 'active'
              ${keyset}
            ORDER BY a.id DESC LIMIT ?`,
        )
        .bind(...binds)
        .all();
      return results.map(toCardRow);
    },

    async countFor(principalId) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM reading_list rl
             JOIN articles a ON a.id = rl.article_id
            WHERE rl.principal_id = ? AND a.status = 'published' AND a.visibility = 'public'`,
        )
        .bind(principalId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    save(principalId, articleId, at) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO reading_list (principal_id, article_id, created_at) VALUES (?, ?, ?)
             ON CONFLICT (principal_id, article_id) DO NOTHING`,
          )
          .bind(principalId, articleId, at),
      );
    },

    remove(principalId, articleId) {
      return asWrite(
        db
          .prepare(`DELETE FROM reading_list WHERE principal_id = ? AND article_id = ?`)
          .bind(principalId, articleId),
      );
    },

    removeAllFor(principalId) {
      return asWrite(db.prepare(`DELETE FROM reading_list WHERE principal_id = ?`).bind(principalId));
    },
  };
}
