import type { Ports } from "./context.js";

/**
 * Retention (SPEC §23.4).
 *
 * §23.4 gives a table of what is kept and for how long, and then one sentence that is the
 * whole reason this file exists: *every table with a bounded retention has a corresponding
 * Cron handler. A table with no cleanup handler is a future incident.*
 *
 * The incident is not usually a bill. It is a database that grows until §31.3's limit stops
 * writes, or a table of hashed addresses that outlives every purpose it was collected for
 * and becomes a liability on the day somebody asks what is in it.
 */

/** SPEC §23.4, transcribed. Hours, so the arithmetic below is one multiplication. */
export const RETENTION_HOURS = {
  /** Delivered outbox rows. The undelivered ones are the pipeline, not a backlog. */
  outbox: 7 * 24,
  /** §34.1 — a key older than this protects nothing; the request it guarded is long over. */
  idempotency: 24,
  /** §21.1 — a record whose bytes never arrived. */
  pendingMedia: 24,
  /**
   * §23.4, §32 — a record the platform detached.
   *
   * A day rather than immediately, and the day is the point. An avatar cleared a minute ago
   * is still named by pages held in browsers and at the edge (§33.2) and by any link preview
   * built while it was current; collecting on the spot turns those into broken images. It is
   * also the window in which somebody who removed a picture by accident can put it back by
   * uploading it again — not the same record, but the same day.
   */
  orphanedMedia: 24,
  /** §23.4 — not deleted. Pseudonymised: the action stays, the person does not. */
  auditIdentity: 365 * 24,
  /**
   * SPEC §66.7 — the deep check's own articles.
   *
   * A healthy run removes its article within seconds. An unhealthy one leaves a tombstone,
   * so the database accumulates one row per failure — evidence of an outage stored forever
   * by the thing that detected it. These are hard-deleted rather than kept, because §23.2's
   * reason for a tombstone does not apply: nobody cites a canary.
   */
  canaryArticles: 24,
  /**
   * SPEC §66.4 — the record of a message the consumer gave up on.
   *
   * Thirty days, which is long enough to be looked at during the incident it belongs to and
   * during the review afterwards, and short enough that a table that only grows when things
   * break does not grow forever. Nothing reads it back into the system: recovery from a dead
   * letter is re-emitting the event, never replaying this row.
   */
  deadLetters: 30 * 24,
  /**
   * SPEC §9.3, §23.4 — a link or a login nonce, counted from when it expired.
   *
   * The credential itself lives ten minutes (`LINK_TTL_MS`, `LOGIN_TTL_MS`), and the row
   * outlives it on purpose: §9.3 sweeps rather than deletes on use, so a second press can be
   * told "already used" instead of "never existed". A day is how long that answer is worth
   * giving. After it the person has asked for another link or given up, and what is left is a
   * spent credential's shadow in a table nothing else reads — which is precisely the table
   * §23.4's rule is about, since neither of these had a handler at all until now.
   */
  telegramNonces: 24,
  /**
   * SPEC §9.3, §61.2 — the record that an event has already been said in a chat.
   *
   * Idempotency with a horizon rather than history. `deliverNotifications` looks back one
   * hour (`NOTIFY_WINDOW_MS`), so a row older than that guards an event no run will select
   * again; the event itself is kept indefinitely and is where the history is. A day rather
   * than the hour, because this row is the only thing between a long outage and somebody
   * being told twice that their article was removed, and a day of that costs one row per
   * notification.
   */
  telegramDeliveries: 24,
} as const;

/**
 * How many rows one pass may touch, per table.
 *
 * Bounded rather than "everything older than", because the first run against a table nobody
 * has ever cleaned is the dangerous one: an unbounded DELETE inside a cron invocation with a
 * wall clock either times out or holds the database while it works. Repeated small passes
 * drain the same backlog, and a pass that does not finish is simply retried on the next
 * schedule.
 */
const BATCH = 500;

export interface RetentionReport {
  canaryArticlesDeleted: number;
  deadLettersDeleted: number;
  outboxDeleted: number;
  idempotencyDeleted: number;
  mediaDeleted: number;
  /** §23.4, §32 — `ready` records nothing referenced, with their objects. */
  orphanedMediaDeleted: number;
  auditPseudonymised: number;
  /** §9.3 — expired nonces, one count per table because they are two credentials. */
  telegramLinksDeleted: number;
  telegramLoginsDeleted: number;
  telegramDeliveriesDeleted: number;
  /** Rows left over because a batch filled up. Non-zero means "run again sooner". */
  moreToDo: boolean;
}

export async function runRetention(ports: Ports): Promise<RetentionReport> {
  const now = ports.clock.now().getTime();
  const before = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  const outboxDeleted = await ports.outbox.deleteSentBefore(before(RETENTION_HOURS.outbox), BATCH);
  const idempotencyDeleted = await ports.idempotency.deleteBefore(
    before(RETENTION_HOURS.idempotency),
    BATCH,
  );
  const auditPseudonymised = await ports.audit.pseudonymiseBefore(
    before(RETENTION_HOURS.auditIdentity),
    BATCH,
  );
  const mediaDeleted = await collectStaleMedia(ports, before(RETENTION_HOURS.pendingMedia));
  const orphanedMediaDeleted = await collectOrphanedMedia(
    ports,
    before(RETENTION_HOURS.orphanedMedia),
  );
  const canaryArticlesDeleted = await collectCanaryArticles(ports, before(RETENTION_HOURS.canaryArticles));
  const deadLettersDeleted = await ports.slo.deleteDeadLettersBefore(
    before(RETENTION_HOURS.deadLetters),
    BATCH,
  );
  const nonceCutoff = before(RETENTION_HOURS.telegramNonces);
  const telegramLinksDeleted = await ports.telegram.deleteLinksBefore(nonceCutoff, BATCH);
  const telegramLoginsDeleted = await ports.telegram.deleteLoginsBefore(nonceCutoff, BATCH);
  const telegramDeliveriesDeleted = await ports.telegram.deleteDeliveriesBefore(
    before(RETENTION_HOURS.telegramDeliveries),
    BATCH,
  );

  return {
    canaryArticlesDeleted,
    deadLettersDeleted,
    outboxDeleted,
    idempotencyDeleted,
    mediaDeleted,
    orphanedMediaDeleted,
    auditPseudonymised,
    telegramLinksDeleted,
    telegramLoginsDeleted,
    telegramDeliveriesDeleted,
    moreToDo:
      outboxDeleted === BATCH ||
      idempotencyDeleted === BATCH ||
      auditPseudonymised === BATCH ||
      deadLettersDeleted === BATCH ||
      telegramLinksDeleted === BATCH ||
      telegramLoginsDeleted === BATCH ||
      telegramDeliveriesDeleted === BATCH,
  };
}

/**
 * `pending` media whose bytes never arrived (SPEC §21.1, §23.4).
 *
 * The object goes before the row, not after. §32.2 makes an object with no row the harmless
 * failure — it is invisible and gets collected — while a row with no object is a record
 * that promises bytes nobody can fetch. If this dies between the two steps, the row is
 * still `pending` and the next pass finds it again.
 *
 * An upload that was interrupted mid-stream may have left part of an object behind, which
 * is why the delete is attempted even for records that were never marked ready.
 */
/**
 * Media the platform detached, past its grace period (SPEC §23.4, §32, §21.2).
 *
 * §32 has always spoken of "the Cron handler that collects orphaned objects" and there was
 * none: only records whose bytes never arrived were collected, so a replaced or removed
 * avatar left its original and every variant produced from it in the bucket, paid for
 * indefinitely. Nobody noticed because nothing breaks — the leak is quiet, and it is the
 * exact failure §23.4's rule about "a table with no cleanup handler" was written to catch,
 * one bucket over.
 *
 * **It collects what was detached, never what merely looks unused.** The first version asked
 * for `ready` media that no column referenced, and that would have deleted pictures out of
 * published articles: a body renders images (§57.1), so an author can embed a media address
 * in Markdown, where no column names it. An inference from absence is the wrong instrument
 * for deciding whether bytes are still wanted.
 *
 * The objects go before the row, which is §32.2's ordering and the same one `collectStaleMedia`
 * follows: an object with no row is invisible and gets collected on a later pass, while a row
 * with no object promises bytes nobody can fetch.
 *
 * The prefix delete covers the variants (§21.2). Deleting `original` alone would leave four
 * derived objects per record behind — which is what "collected" would have quietly meant.
 */
async function collectOrphanedMedia(ports: Ports, cutoff: string): Promise<number> {
  const orphaned = await ports.media.listCollectable(cutoff, 100);
  if (orphaned.length === 0) return 0;

  for (const id of orphaned) {
    try {
      await ports.mediaStore.deleteAll(`${id}/`);
    } catch (error) {
      console.error(
        JSON.stringify({ level: "warn", event: "retention.media.unreferenced", id, error: String(error) }),
      );
    }
  }

  await ports.db.commit([ports.media.deleteRecords(orphaned)]);
  return orphaned.length;
}

async function collectStaleMedia(ports: Ports, cutoff: string): Promise<number> {
  const stale = await ports.media.listStalePending(cutoff, 100);
  if (stale.length === 0) return 0;

  for (const id of stale) {
    try {
      await ports.mediaStore.delete(`${id}/original`);
    } catch (error) {
      // A bucket that refuses is not a reason to keep the row: the row is the thing that
      // makes a promise to a reader, and the object is unreachable without it.
      console.error(
        JSON.stringify({ level: "warn", event: "retention.media.orphaned", id, error: String(error) }),
      );
    }
  }

  await ports.db.commit([ports.media.deleteRecords(stale)]);
  return stale.length;
}

/**
 * The deep check's leftovers (SPEC §66.7, §23.2).
 *
 * §23.2 keeps a removed article's id resolving so that citations to it still answer. A
 * canary article was never citable — it is excluded from feeds, search and the sitemap, and
 * it existed for seconds — so the tombstone protects nothing and the row is deleted outright.
 */
async function collectCanaryArticles(ports: Ports, cutoff: string): Promise<number> {
  const stale = await ports.articles.listSystemArticlesBefore(cutoff, 100);
  if (stale.length === 0) return 0;
  await ports.db.commit(ports.articles.deleteArticles(stale));
  return stale.length;
}
