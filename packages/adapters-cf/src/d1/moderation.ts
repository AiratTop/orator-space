import type { ModerationRepo, NewReport } from "@orator/core/ports";
import { asWrite } from "./database.js";

/** SPEC §61 over D1. */
export function createModerationRepo(db: D1Database): ModerationRepo {
  return {
    insertReport(report: NewReport) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO reports
               (id, target_type, target_id, reporter_principal_id, reporter_contact,
                category, details, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .bind(
            report.id,
            report.targetType,
            report.targetId,
            report.reporterPrincipalId,
            report.reporterContact,
            report.category,
            report.details,
            report.createdAt,
          ),
      );
    },

    /**
     * How many reports this target has attracted lately.
     *
     * Not a moderation decision — that is §61's job and it is a launch-gate concern. This
     * exists so that intake can refuse the hundredth identical report about one article
     * without turning the queue into a denial-of-service surface.
     */
    async countRecentReports(targetType, targetId, since) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM reports
            WHERE target_type = ? AND target_id = ? AND created_at >= ?`,
        )
        .bind(targetType, targetId, since)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
