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
  /** §23.4 — not deleted. Pseudonymised: the action stays, the person does not. */
  auditIdentity: 365 * 24,
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
  outboxDeleted: number;
  idempotencyDeleted: number;
  mediaDeleted: number;
  auditPseudonymised: number;
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

  return {
    outboxDeleted,
    idempotencyDeleted,
    mediaDeleted,
    auditPseudonymised,
    moreToDo:
      outboxDeleted === BATCH || idempotencyDeleted === BATCH || auditPseudonymised === BATCH,
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
