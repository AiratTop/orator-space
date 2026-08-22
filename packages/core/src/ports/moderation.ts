import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/** SPEC §61 — report intake. Review and action arrive with the launch gate. */

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

export interface ModerationRepo {
  insertReport(report: NewReport): PendingWrite;
  countRecentReports(targetType: string, targetId: string, since: string): Promise<number>;
}
