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

export interface ModerationRepo {
  insertReport(report: NewReport): PendingWrite;
  countRecentReports(targetType: string, targetId: string, since: string): Promise<number>;

  /** The queue itself: oldest first, because that is the order a moderator works in. */
  listReports(status: ReportStatus | null, limit: number, after: string | null): Promise<ReportRecord[]>;
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
  /** The object's operational history — what was done to it, and whether it was reversed. */
  listActions(targetType: string, targetId: string, limit: number): Promise<ModerationActionRecord[]>;
  /** Marks the most recent unreversed action of this kind as reversed (`restore`). */
  reverseAction(id: string, at: string): PendingWrite;
  findLastAction(targetType: string, targetId: string): Promise<ModerationActionRecord | null>;
}
