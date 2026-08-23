/**
 * What an operator needs to know about the pipeline (SPEC §66.4).
 *
 * §66.4 names seven indicators and calls them mandatory from day one. Four of them are
 * questions about the database and are answered here; two are questions about request
 * traffic and belong to Analytics Engine (§66.2), which is a different port because it is a
 * different system with a different failure mode — a metrics backend that is unreachable
 * must degrade the report rather than fail it.
 *
 * Deliberately separate from `ReadingRepo`. Nothing here is about content, none of it is
 * cached, and every query is one an operator runs and a reader never does.
 */

export interface OutboxBacklog {
  pending: number;
  /** Null when the backlog is empty. */
  oldestPendingAt: string | null;
}

/**
 * How long an article takes to become findable (SPEC §66.4, §34.4).
 *
 * The one indicator that measures the whole asynchronous half at once: a value here means
 * the outbox drained, the queue delivered, the consumer ran and the index was written. The
 * sample is bounded — a percentile over the last N indexed articles, not over the corpus.
 */
export interface IndexingLag {
  sampled: number;
  p95Seconds: number | null;
}

export interface SloRepo {
  outboxBacklog(): Promise<OutboxBacklog>;
  indexingLag(sample: number): Promise<IndexingLag>;
  /** How many messages the consumer gave up on since `since`. */
  deadLettered(since: string): Promise<number>;
  /**
   * The database's size in bytes, or null where the platform does not report it.
   *
   * D1 returns it in the metadata of any statement. A local development database does not,
   * which is why null is a state rather than an error: the check says "unavailable" and does
   * not raise an alert about a number nobody can read.
   */
  databaseBytes(): Promise<number | null>;
  /**
   * SPEC §23.4 — the record of a failure is not kept forever.
   *
   * Bounded per call like every other retention pass: a first run against a table nobody has
   * cleaned would be one enormous DELETE inside a cron invocation with a wall clock.
   */
  deleteDeadLettersBefore(cutoff: string, limit: number): Promise<number>;
}

/**
 * The two indicators that live in Analytics Engine (SPEC §66.2, §66.4).
 *
 * Every method may answer null, and null means "no metrics backend is configured" rather
 * than "the value is zero". §80.15 leaves the choice of backend open; until it is taken,
 * these two indicators report as unavailable and the report says so out loud instead of
 * quietly claiming health.
 */
export interface MetricsQuery {
  /** p95 of `publishArticle`, in milliseconds, over the window. */
  publishLatencyP95Ms(windowMinutes: number): Promise<number | null>;
  /** Share of responses in the 5xx range over the window, as a fraction of all responses. */
  serverErrorRate(windowMinutes: number): Promise<number | null>;
}
