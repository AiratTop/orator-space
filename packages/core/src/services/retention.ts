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
  /**
   * §16.2, §32.2 — a body whose revision row may still be on its way.
   *
   * Shorter than the media grace period and for a different reason: nothing caches a body by
   * its hash, so this is not about readers holding a stale reference. It is about the write
   * order — the object goes to the store before the row goes to the database, so an object
   * with no row is either a failed commit or a commit in progress, and one hour tells those
   * apart with room to spare.
   */
  orphanedContent: 1,
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
  /**
   * SPEC §23.4, §62 — a session that is revoked or expired, counted from when it died.
   *
   * Thirty days, which is the retention of the request logs (§23.4) and deliberately the same
   * number: a dead session should not outlive the record of the requests it made. Nothing
   * reads these rows — `findByHash` checks the clock and the revocation, `listFor` answers
   * "where am I signed in" — so what is kept is a `user_agent` and an `ip_hash` about a
   * person, in a table that had no bound at all. The revocation itself survives as
   * `session.revoked` in the audit log, which is where §62 asks that question.
   */
  deadSessions: 30 * 24,
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
export const RETENTION_BATCH = 500;

/**
 * The ceiling for the passes that read a list before acting on it.
 *
 * Media and canary articles are not one statement: each row is an object in R2 (or several,
 * §21.2) deleted before the row is. A hundred of those in a pass is a different unit of work
 * from five hundred `DELETE`s, and giving it its own number says so rather than hiding it in
 * a literal.
 */
const OBJECT_BATCH = 100;

/** D1 permits 100 bound parameters per query (§31.1); 90 leaves room for the rest of one. */
const REFERENCE_CHUNK = 90;

/**
 * How many times one invocation will go round.
 *
 * `moreToDo` used to be returned, logged and read by nobody, which made every ceiling above a
 * hard limit of `RETENTION_BATCH` rows per table per *day* — the cron runs at 04:17 and nothing else
 * calls this. That is fine until a table takes more than five hundred rows a day, at which
 * point retention silently stops keeping up and the report says so in a field no one is
 * watching. Ten passes is 5,000 rows a table, drains any backlog this deployment can plausibly
 * build, and still bounds the invocation.
 *
 * A pass that fills its batch means there is more; the loop stops on the first pass that does
 * not, so a quiet night costs exactly one pass.
 */
const MAX_PASSES = 10;

export interface RetentionReport {
  canaryArticlesDeleted: number;
  deadLettersDeleted: number;
  outboxDeleted: number;
  idempotencyDeleted: number;
  mediaDeleted: number;
  /** §23.4, §32 — `ready` records nothing referenced, with their objects. */
  orphanedMediaDeleted: number;
  /** §32.2 — bodies under `content/*` that no live revision references any more. */
  orphanedContentDeleted: number;
  auditPseudonymised: number;
  /** §9.3 — expired nonces, one count per table because they are two credentials. */
  telegramLinksDeleted: number;
  telegramLoginsDeleted: number;
  telegramDeliveriesDeleted: number;
  /** §23.4, §62 — revoked or expired sessions, with the person's agent and address in them. */
  sessionsDeleted: number;
  /** How many passes it took. `MAX_PASSES` with `moreToDo` means it ran out of passes. */
  passes: number;
  /**
   * Work left after the last pass.
   *
   * True here is not "there was a lot to do" — the loop keeps going while there is. It means
   * `MAX_PASSES` was spent and a table was still full, which is a backlog growing faster than
   * a daily invocation drains it and wants looking at rather than logging.
   */
  moreToDo: boolean;
}

/**
 * One invocation: passes until nothing fills a batch, or until the passes run out.
 *
 * `maxPasses` is a parameter so a test can prove the ceiling holds without writing five
 * thousand rows; nothing in the application passes it.
 */
export async function runRetention(ports: Ports, maxPasses = MAX_PASSES): Promise<RetentionReport> {
  const total = empty();
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const one = await onePass(ports);
    add(total, one);
    total.passes = pass;
    if (!one.moreToDo) return total;
  }
  total.moreToDo = true;
  return total;
}

const empty = (): RetentionReport => ({
  canaryArticlesDeleted: 0,
  deadLettersDeleted: 0,
  outboxDeleted: 0,
  idempotencyDeleted: 0,
  mediaDeleted: 0,
  orphanedMediaDeleted: 0,
  orphanedContentDeleted: 0,
  auditPseudonymised: 0,
  telegramLinksDeleted: 0,
  telegramLoginsDeleted: 0,
  telegramDeliveriesDeleted: 0,
  sessionsDeleted: 0,
  passes: 0,
  moreToDo: false,
});

function add(total: RetentionReport, pass: RetentionReport): void {
  total.canaryArticlesDeleted += pass.canaryArticlesDeleted;
  total.deadLettersDeleted += pass.deadLettersDeleted;
  total.outboxDeleted += pass.outboxDeleted;
  total.idempotencyDeleted += pass.idempotencyDeleted;
  total.mediaDeleted += pass.mediaDeleted;
  total.orphanedMediaDeleted += pass.orphanedMediaDeleted;
  total.orphanedContentDeleted += pass.orphanedContentDeleted;
  total.auditPseudonymised += pass.auditPseudonymised;
  total.telegramLinksDeleted += pass.telegramLinksDeleted;
  total.telegramLoginsDeleted += pass.telegramLoginsDeleted;
  total.telegramDeliveriesDeleted += pass.telegramDeliveriesDeleted;
  total.sessionsDeleted += pass.sessionsDeleted;
}

async function onePass(ports: Ports): Promise<RetentionReport> {
  const now = ports.clock.now().getTime();
  const before = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  const outboxDeleted = await ports.outbox.deleteSentBefore(before(RETENTION_HOURS.outbox), RETENTION_BATCH);
  const idempotencyDeleted = await ports.idempotency.deleteBefore(
    before(RETENTION_HOURS.idempotency),
    RETENTION_BATCH,
  );
  const auditPseudonymised = await ports.audit.pseudonymiseBefore(
    before(RETENTION_HOURS.auditIdentity),
    RETENTION_BATCH,
  );
  const mediaDeleted = await collectStaleMedia(ports, before(RETENTION_HOURS.pendingMedia));
  const orphanedMediaDeleted = await collectOrphanedMedia(
    ports,
    before(RETENTION_HOURS.orphanedMedia),
  );
  const contentSweep = await collectOrphanedContent(
    ports,
    before(RETENTION_HOURS.orphanedContent),
    new Date(now).toISOString(),
  );
  const canaryArticlesDeleted = await collectCanaryArticles(ports, before(RETENTION_HOURS.canaryArticles));
  const deadLettersDeleted = await ports.slo.deleteDeadLettersBefore(
    before(RETENTION_HOURS.deadLetters),
    RETENTION_BATCH,
  );
  const nonceCutoff = before(RETENTION_HOURS.telegramNonces);
  const telegramLinksDeleted = await ports.telegram.deleteLinksBefore(nonceCutoff, RETENTION_BATCH);
  const telegramLoginsDeleted = await ports.telegram.deleteLoginsBefore(nonceCutoff, RETENTION_BATCH);
  const telegramDeliveriesDeleted = await ports.telegram.deleteDeliveriesBefore(
    before(RETENTION_HOURS.telegramDeliveries),
    RETENTION_BATCH,
  );
  const sessionsDeleted = await ports.sessions.deleteDeadBefore(
    before(RETENTION_HOURS.deadSessions),
    RETENTION_BATCH,
  );

  return {
    canaryArticlesDeleted,
    deadLettersDeleted,
    outboxDeleted,
    idempotencyDeleted,
    mediaDeleted,
    orphanedMediaDeleted,
    orphanedContentDeleted: contentSweep.deleted,
    auditPseudonymised,
    telegramLinksDeleted,
    telegramLoginsDeleted,
    telegramDeliveriesDeleted,
    sessionsDeleted,
    passes: 1,
    /*
     * A pass that filled a batch had more to give, whichever table it was.
     *
     * The two that read a list first are in here as well, against their own smaller ceiling —
     * leaving them out is how a hundred orphaned avatars a day became the quiet maximum.
     */
    moreToDo:
      outboxDeleted === RETENTION_BATCH ||
      idempotencyDeleted === RETENTION_BATCH ||
      auditPseudonymised === RETENTION_BATCH ||
      deadLettersDeleted === RETENTION_BATCH ||
      telegramLinksDeleted === RETENTION_BATCH ||
      telegramLoginsDeleted === RETENTION_BATCH ||
      telegramDeliveriesDeleted === RETENTION_BATCH ||
      sessionsDeleted === RETENTION_BATCH ||
      mediaDeleted === OBJECT_BATCH ||
      orphanedMediaDeleted === OBJECT_BATCH ||
      // Position, not count: a page where nothing was collectable still leaves a next page.
      contentSweep.more ||
      canaryArticlesDeleted === OBJECT_BATCH,
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
/**
 * SPEC §32.2 — "content no revision references" is deleted by the Cron handler.
 *
 * The half of §32.2 that was never built. `collectOrphanedMedia` existed; the content store
 * had nothing, and erasure quietly depended on a collector that did not.
 *
 * That dependency is real and not hypothetical. §23.3 step 3 refuses to delete an object
 * another revision still points at, so a body shared by two articles survives the first
 * erasure by design. It becomes collectable when the last live reference goes — and until
 * now nothing ever looked again, so the bytes stayed for good. Two people exercising the
 * same right, in sequence, and the data outliving both requests.
 *
 * No cutoff. The other collectors wait a day because something may still be pointing at what
 * they remove — a cached page, a link preview. Nothing points at this: every revision
 * carrying the hash has had its `content_ref` blanked, which is what makes it collectable in
 * the first place, and a reader reaching a blanked revision gets §23.2's tombstone rather
 * than a fetch.
 *
 * **What it does not find.** An object written to R2 whose revision row never committed is
 * invisible here — there is no `content_hash` to group by, so it appears in no query over
 * `revisions`. Finding those needs a listing of the bucket rather than a query, which is a
 * different operation with a different cost, and §16.2's write order makes them rare: the
 * object is written first precisely so that a failure leaves an unreferenced object rather
 * than a revision with no body.
 */
const CONTENT_SWEEP = "content";

async function collectOrphanedContent(
  ports: Ports,
  cutoff: string,
  now: string,
): Promise<{ deleted: number; more: boolean }> {
  /*
   * Resumed, because a Cron invocation is not where a sweep of a bucket fits.
   *
   * The first version read `list({ limit: 100 })` and threw the cursor away, so every run
   * examined page one and nothing else — a hundred live objects at the head of the listing
   * hid every orphan behind them permanently. The test that should have caught it passed
   * because all 250 of its objects were orphans: the first page emptied, the second became
   * the first, and the sweep appeared to advance. A test that passes for a reason other than
   * the one it names is worse than no test, and this one is now three tests that each put
   * something *live* in front of the orphan.
   */
  const from = await ports.retentionCursors.read(CONTENT_SWEEP);

  /*
   * A stored cursor the store will not accept any more starts the sweep over.
   *
   * R2's cursor is an opaque token and nothing promises it survives a bucket being recreated,
   * a long enough gap, or a change on the platform's side. A checkpoint that has stopped
   * being valid would otherwise be re-read and re-rejected on every invocation, for good —
   * a sweep permanently stuck on a value nobody can see, which is the same failure as the
   * first page but harder to notice because it has no page.
   *
   * Dropping it costs one sweep from the beginning, which is a thing this handler does
   * routinely anyway. Not narrowed to a particular error: nothing distinguishes "bad cursor"
   * from anything else here, and the recovery is correct for both.
   */
  let page;
  try {
    page = await ports.content.list({ cursor: from, limit: OBJECT_BATCH });
  } catch (error) {
    if (from === null) throw error;
    console.error(
      JSON.stringify({ level: "warn", event: "retention.content.cursor.dropped", error: String(error) }),
    );
    await ports.db.commit([ports.retentionCursors.write(CONTENT_SWEEP, null, now)]);
    return { deleted: 0, more: true };
  }
  const { objects, cursor } = page;

  /*
   * The cursor moves on every pass, whatever was deleted.
   *
   * Progress is position, not deletions. Advancing only when something was removed is the
   * same bug in a different shape: a page of live objects would pin the sweep to it forever.
   * A null cursor is the end of the listing and drops the row, so the next invocation starts
   * a fresh sweep from the beginning — which is also how an object that became collectable
   * behind the cursor is eventually reached.
   */
  await ports.db.commit([ports.retentionCursors.write(CONTENT_SWEEP, cursor, now)]);

  if (objects.length === 0) return { deleted: 0, more: cursor !== null };

  /*
   * Old enough that a revision row pointing at it would have committed by now.
   *
   * §16.2 writes the object before the row, deliberately: a failure that way round leaves an
   * unreferenced object rather than a revision with no body. It also means a body seconds
   * old may be one whose row is still in flight, and collecting it would turn this handler
   * into the cause of the very thing it cleans up. An hour is far beyond any request.
   */
  const candidates = objects.filter((object) => object.uploadedAt < cutoff);
  if (candidates.length === 0) return { deleted: 0, more: cursor !== null };

  // D1 permits 100 bound parameters per query (§31.1), and the whole point of asking in
  // bulk is to not ask once per object.
  const live = new Set<string>();
  for (let at = 0; at < candidates.length; at += REFERENCE_CHUNK) {
    const chunk = candidates.slice(at, at + REFERENCE_CHUNK).map((object) => object.contentHash);
    for (const hash of await ports.articles.liveContentHashes(chunk)) live.add(hash);
  }

  const orphaned = candidates.filter((object) => !live.has(object.contentHash));
  if (orphaned.length === 0) return { deleted: 0, more: cursor !== null };

  try {
    await ports.content.deleteMany(orphaned.map((object) => object.contentHash));
  } catch (error) {
    // The cursor has already moved, so this page is not retried on the next pass — it is
    // retried on the next sweep. Losing a page of deletions to a transient store failure is
    // the right trade against a sweep that cannot get past a page it keeps failing on.
    console.error(
      JSON.stringify({ level: "warn", event: "retention.content.unreferenced", error: String(error) }),
    );
    return { deleted: 0, more: cursor !== null };
  }
  return { deleted: orphaned.length, more: cursor !== null };
}

async function collectOrphanedMedia(ports: Ports, cutoff: string): Promise<number> {
  const orphaned = await ports.media.listCollectable(cutoff, OBJECT_BATCH);
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
  const stale = await ports.media.listStalePending(cutoff, OBJECT_BATCH);
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
  const stale = await ports.articles.listSystemArticlesBefore(cutoff, OBJECT_BATCH);
  if (stale.length === 0) return 0;
  await ports.db.commit(ports.articles.deleteArticles(stale));
  return stale.length;
}
