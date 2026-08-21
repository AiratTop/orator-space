/**
 * The write model (SPEC §31.1).
 *
 * D1 has no interactive transactions: there is no `BEGIN … await … COMMIT`, only a batch
 * executed atomically. Rather than leave that as a rule people remember, it is encoded
 * here. A repository cannot save anything by itself — it returns a `PendingWrite`, and
 * only `Database.commit` turns a set of them into a transaction.
 *
 * The consequence that matters: writing a domain change and its outbox row in one call
 * is the *only* thing the API makes easy, so the atomicity §35.2 depends on is the
 * default rather than something to remember.
 */

/** Opaque: the domain composes these but cannot inspect or execute one. */
export type PendingWrite = { readonly __brand: unique symbol };

/** How many rows a single write actually touched. */
export interface WriteOutcome {
  changes: number;
}

export interface Database {
  /**
   * Executes every write as one transaction. All of them apply, or none do.
   *
   * Returns one outcome per write, in order. Services need the row count to detect a
   * conditional update that did not apply — an `UPDATE … WHERE current_revision_id = ?`
   * touching zero rows is how optimistic concurrency reports a conflict (SPEC §34.3).
   * Reading state first and then writing would be a race; the count is the only answer
   * that is atomic with the write.
   */
  commit(writes: readonly PendingWrite[]): Promise<WriteOutcome[]>;
}

/** Thrown when a commit violates a constraint the schema enforces (SPEC §7.2, §17, §18). */
export class ConstraintViolation extends Error {
  constructor(
    message: string,
    readonly constraint: "foreign-key" | "unique" | "check" | "unknown",
  ) {
    super(message);
    this.name = "ConstraintViolation";
  }
}
