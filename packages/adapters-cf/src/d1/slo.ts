import type { SloRepo } from "@orator/core/ports";

/**
 * The §66.4 indicators that D1 can answer (SPEC §66.4).
 *
 * Four of the seven are questions about state rather than about traffic, and state is in the
 * database: how deep the outbox is, how long publishing takes to become findable, what the
 * consumer gave up on, and how much of the ceiling is used. None of them needs a metrics
 * pipeline, and reading them here is what lets six of the seven rows close without one.
 */
export function createSloRepo(db: D1Database): SloRepo {
  return {
    async outboxBacklog() {
      // Both numbers from one statement, served by `ix_outbox_drain` (migration 0027).
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest
             FROM outbox WHERE status = 'pending'`,
        )
        .first<{ pending: number; oldest: string | null }>();
      return { pending: row?.pending ?? 0, oldestPendingAt: row?.oldest ?? null };
    },

    async sweepLastRun(handler) {
      // One row, by primary key. §66.4's cheapest indicator by a wide margin, and it has to
      // be: the sweep it watches was built to stop reading the corpus on a timer.
      const row = await db
        .prepare(`SELECT cursor, updated_at FROM retention_cursors WHERE handler = ?`)
        .bind(handler)
        .first<{ cursor: string; updated_at: string }>();
      return row === null ? null : { position: row.cursor, at: row.updated_at };
    },

    /**
     * The publish event to the index entry, over the last `sample` articles indexed.
     *
     * Measured from the event and not from `articles.published_at`, which is a different
     * quantity that looks like this one. `published_at` is what the author says, and §15.1
     * has an import carry the original date: staging's p95 was 78 million seconds — two and
     * a half years, from one imported article per end-to-end run. And for anything published
     * twice it is the first publish, while `indexed_at` is the latest index write, so an
     * edited article reported the gap between two unrelated moments (84 s against a real 6).
     * Both read as an outage in the one indicator that watches the queue.
     *
     * `ix_events_subject` is (subject_type, subject_id, id DESC), so each row costs a seek
     * into the newest event for that article rather than a scan.
     *
     * The percentile is computed here rather than in SQL: D1 is SQLite and SQLite has no
     * percentile function, and the alternatives — a window function over a subquery, or a
     * LIMIT/OFFSET into an ordered set — are both more code than sorting fifty numbers.
     *
     * A negative difference is dropped rather than clamped. It means the two timestamps came
     * from different clocks (the index is written by the queue consumer, the event by the
     * request), and a value that says indexing finished before publishing started is not a
     * fast one, it is a wrong one.
     */
    async indexingLag(sample) {
      const { results } = await db
        .prepare(
          `SELECT d.indexed_at AS indexed,
                  (SELECT e.created_at FROM events e
                    WHERE e.subject_type = 'article'
                      AND e.subject_id = d.article_id
                      AND e.type = 'article.published'
                    ORDER BY e.id DESC LIMIT 1) AS published
             FROM search_docs d
            ORDER BY d.doc_id DESC
            LIMIT ?`,
        )
        .bind(sample)
        .all<{ published: string | null; indexed: string }>();

      const seconds = results
        .map((row) => (row.published === null ? NaN : (Date.parse(row.indexed) - Date.parse(row.published)) / 1000))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((a, b) => a - b);

      if (seconds.length === 0) return { sampled: 0, p95Seconds: null };

      // Nearest-rank: the smallest value at or above the 95th percentile of the sample.
      const rank = Math.max(0, Math.ceil(seconds.length * 0.95) - 1);
      return { sampled: seconds.length, p95Seconds: seconds[rank] ?? null };
    },

    async deadLettered(since) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE arrived_at >= ?`)
        .bind(since)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    /**
     * D1 reports the database's size in the metadata of any statement.
     *
     * So the cheapest possible query carries the answer, and nothing has to be counted.
     * Null is a state rather than an error, for a platform or a local runtime that does not
     * fill the field in: the report says "unavailable" rather than alerting on a number
     * nobody can read, or — worse — reading its absence as a comfortable zero.
     */
    async databaseBytes() {
      const { meta } = await db.prepare(`SELECT 1`).all();
      const size = (meta as { size_after?: unknown }).size_after;
      return typeof size === "number" ? size : null;
    },

    async deleteDeadLettersBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `DELETE FROM dead_letters
            WHERE id IN (SELECT id FROM dead_letters WHERE arrived_at < ? LIMIT ?)`,
        )
        .bind(cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },
  };
}

/**
 * Recording a message the pipeline gave up on (SPEC §66.4, §35.3).
 *
 * Not part of `SloRepo`: that port reads, and this writes. It is here because it is the same
 * table and the same subject, and because the writer is the dead-letter consumer rather than
 * anything in the domain — nothing about a failed delivery is a domain event.
 *
 * `INSERT OR IGNORE` against the unique index on `event_id`, so a message redelivered from
 * the dead-letter queue is one row rather than several. A message with no id it could parse
 * has no key to collide on and is recorded every time, which is correct: that is the failure
 * with the least information attached and the one worth seeing twice.
 */
export function recordDeadLetter(db: D1Database) {
  return async (entry: {
    id: string;
    eventId: string | null;
    eventType: string | null;
    aggregateId: string | null;
    error: string | null;
    arrivedAt: string;
  }): Promise<void> => {
    await db
      .prepare(
        `INSERT OR IGNORE INTO dead_letters (id, event_id, event_type, aggregate_id, error, arrived_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.id,
        entry.eventId,
        entry.eventType,
        entry.aggregateId,
        entry.error === null ? null : entry.error.slice(0, 500),
        entry.arrivedAt,
      )
      .run();
  };
}
