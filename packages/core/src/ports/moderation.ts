import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/** SPEC §61 — report intake, the review queue, and the actions taken from it. */

export type ReportCategory = "spam" | "illegal" | "copyright" | "abuse" | "injection" | "other";

export interface NewReport {
  id: OratorId;
  targetType: "article" | "comment" | "principal" | "media";
  targetId: string;
  /** Null for an anonymous report — §61.2 does not require an account to report. */
  reporterPrincipalId: OratorId | null;
  reporterContact: string | null;
  /**
   * A person, or the platform's own screening (§58.2, §61).
   *
   * Both arrive with no principal, and until this existed the queue could not tell them apart:
   * a machine's flag rendered as "from anonymous", which is false and reads as one more member
   * of the public agreeing. They carry different weight and want different follow-up.
   */
  source: "human" | "automatic";
  category: ReportCategory;
  details: string | null;
  createdAt: string;
}

export type ReportStatus = "open" | "reviewing" | "actioned" | "rejected";

export interface ReportRecord extends NewReport {
  status: ReportStatus;
  resolution: string | null;
  reviewedBy: OratorId | null;
  reviewedAt: string | null;
}

/** SPEC §61.1 — what a moderator may do, and nothing beyond it. */
export type ModerationActionKind = "hide" | "remove" | "unindex" | "suspend" | "restore" | "warn";

export interface NewModerationAction {
  id: OratorId;
  targetType: "article" | "comment" | "principal" | "media";
  targetId: string;
  action: ModerationActionKind;
  /** A short stable code, not prose: it reaches the author through an event (§61.2). */
  reasonCode: string;
  reasonText: string | null;
  source: "report" | "automatic" | "legal" | "proactive";
  reportId: OratorId | null;
  /** Null when the action was automatic — a provider's verdict, not a person's. */
  actorPrincipalId: OratorId | null;
  createdAt: string;
}

export interface ModerationActionRecord extends NewModerationAction {
  reversedAt: string | null;
}

/**
 * What a queue entry is *about*, in words (SPEC §61.1).
 *
 * The report row names a type and an id and nothing else, which is right for a record and
 * useless for a queue: fifty lines reading `article 06G2G3ZB8N…` are fifty lines a moderator
 * has to open one at a time to find out what they are deciding. The subject line is a display
 * concern, so it is resolved separately rather than added to `ReportRecord` — the record
 * mirrors a table, and a title is not in that table.
 *
 * Deliberately not "the article view": a report can name an article that is already hidden or
 * removed, and the queue must still say which one it is. This reads the revision directly for
 * that reason, and returns `null` rather than failing when the target is gone.
 */
export interface ReportTarget {
  targetType: ReportRecord["targetType"];
  targetId: string;
}

export interface TargetSummary extends ReportTarget {
  /** An article's title, a comment's opening words, a principal's name. Null if it is gone. */
  label: string | null;
  /** For a comment, the article it is on, so the queue can link to where it is read. */
  articleId: string | null;
  /**
   * For an article, what screening made of it (§58.2, §61): `passed`, `flagged`, `unchecked`.
   *
   * Null for every other kind of target, which has no such column, and for an article that is
   * gone. On the queue it is the difference between a report that agrees with the platform's
   * own reader and one that contradicts it — the second is the more interesting of the two and
   * looked identical to the first until this was carried here.
   */
  screening: string | null;
  /**
   * For a principal, the handle its page is addressed by (SPEC §7.3, §61.1).
   *
   * Carried rather than derived, which is the whole point of it being here: the label is
   * `display_name ?? "@" + username`, and a queue that recovered the address by parsing the
   * label linked correctly for everybody who had not set a display name and nowhere for
   * everybody who had. A summary should say where a thing is, not leave a page to guess.
   */
  username: string | null;
}

/** What a page of the queue is a page of (SPEC §61.1). */
export interface ReportQuery {
  /** Empty or null means every status. The queue asks for `open` and `reviewing` together. */
  status: readonly ReportStatus[] | null;
  /** Null means every kind of target. */
  targetType: ReportTarget["targetType"] | null;
  order?: "oldest" | "newest";
}

export interface ModerationRepo {
  insertReport(report: NewReport): PendingWrite;

  /**
   * The subject lines for a page of the queue, in one round trip per target type.
   *
   * Takes the whole page rather than one target at a time: fifty reports is fifty queries
   * done the obvious way, on a page a moderator opens repeatedly.
   */
  describeTargets(targets: readonly ReportTarget[]): Promise<TargetSummary[]>;

  /**
   * The handles behind a page of reporters (SPEC §61.1).
   *
   * Batched for the reason `describeTargets` is: fifty reports done the obvious way is fifty
   * queries on a page a moderator opens repeatedly. Distinct ids only, so the parameter count
   * is bounded by the page size rather than by how many reports one person filed — which
   * matters, because that is exactly the shape this column exists to make visible.
   *
   * An id with no row comes back absent rather than as an error: a reporter whose account was
   * closed (§23.5) keeps the report they filed, and the queue still has to render the line.
   */
  describeReporters(ids: readonly string[]): Promise<{ id: string; username: string }[]>;
  countRecentReports(targetType: string, targetId: string, since: string): Promise<number>;

  /**
   * A report this reporter already has open against this target (SPEC §61.1).
   *
   * `countRecentReports` bounds how often a *target* can be reported and cannot see one
   * person filing about it repeatedly — twenty rows from one reporter is under that ceiling
   * and is the shape abuse takes. This answers the other question, and only for a reporter
   * with an account: an anonymous report has nobody to be the same person as.
   *
   * Open, not ever: once a moderator has closed it, the state of the world has changed —
   * the content may have been revised, or the verdict may have been wrong — and a second
   * report is a new statement rather than a repeat of the old one.
   */
  findOpenReportBy(
    reporterPrincipalId: string,
    targetType: string,
    targetId: string,
  ): Promise<ReportRecord | null>;

  /**
   * The queue itself (SPEC §61.1).
   *
   * Oldest first by default, because that is the order a backlog is worked in. `newest`
   * exists because a backlog is not the only thing a queue is: a moderator who has just been
   * told something was reported is asking a question the oldest fifty cannot answer, and on
   * a queue of any size the newest entry is on the last page. Keyset either way (§44.2) —
   * the cursor compares in the direction the page is running.
   *
   * `status` is a set rather than one value because the queue is two statuses: `reviewing`
   * is a report somebody claimed and has not finished, which is still work. Two queries
   * merged in the caller cannot be paged — each has its own cursor and the merge has none —
   * and the count would describe a different population from the page.
   *
   * `targetType` is the filter that makes a deep queue workable: "the accounts" and "the
   * comments" are different jobs, done in different states of mind, and a moderator who has
   * an hour for one of them should not have to read the other to find it.
   */
  listReports(query: ReportQuery & { limit: number; after: string | null }): Promise<ReportRecord[]>;

  /**
   * How many reports match (SPEC §61.1).
   *
   * A count, which §44.2 keeps out of pagination for reasons that hold — it cannot be made
   * consistent with a keyset page, and it costs an index scan. It is here for the reason
   * `countPublished` is: orientation rather than paging. A page showing fifty of five
   * hundred and thirty-three without saying so is not a queue, it is a sample, and a
   * moderator cannot tell the difference by looking.
   *
   * Takes the same filter as the listing, necessarily: a count over a wider population than
   * the page shows is a number that describes something else.
   */
  countReports(query: ReportQuery): Promise<number>;
  findReport(id: string): Promise<ReportRecord | null>;
  /**
   * Moves a report along, but only from the state the caller believed it was in.
   *
   * The `expected` argument is the concurrency control: two moderators opening the same
   * queue is the ordinary case, and without it the second one silently overwrites the
   * first's resolution. A zero row count is the signal that somebody got there first.
   */
  setReportStatus(
    id: string,
    status: ReportStatus,
    expected: ReportStatus[],
    reviewedBy: OratorId | null,
    resolution: string | null,
    at: string,
  ): PendingWrite;

  insertAction(action: NewModerationAction): PendingWrite;

  /**
   * What has been done lately, across everything (SPEC §61.1).
   *
   * `listActions` answers "what happened to this object"; this answers "what has this
   * platform been doing", which is the question a moderation section has to answer before it
   * can offer to undo any of it. Newest first, because the thing most likely to need
   * reversing is the thing just done.
   */
  listRecentActions(limit: number, before: string | null): Promise<ModerationActionRecord[]>;
  /** The object's operational history — what was done to it, and whether it was reversed. */
  listActions(targetType: string, targetId: string, limit: number): Promise<ModerationActionRecord[]>;
  /** Marks the most recent unreversed action of this kind as reversed (`restore`). */
  reverseAction(id: string, at: string): PendingWrite;
  findLastAction(targetType: string, targetId: string): Promise<ModerationActionRecord | null>;
}
