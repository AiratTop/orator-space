import type {
  ModerationActionRecord,
  ModerationRepo,
  NewModerationAction,
  NewReport,
  ReportRecord,
  ReportStatus,
  TargetSummary,
} from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/** SPEC §61 over D1. */
interface ReportRow {
  id: string;
  target_type: string;
  target_id: string;
  reporter_principal_id: string | null;
  reporter_contact: string | null;
  category: string;
  details: string | null;
  status: string;
  resolution: string | null;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface ActionRow {
  id: string;
  target_type: string;
  target_id: string;
  action: string;
  reason_code: string;
  reason_text: string | null;
  source: string;
  report_id: string | null;
  actor_principal_id: string | null;
  reversed_at: string | null;
  created_at: string;
}

const toReport = (row: ReportRow): ReportRecord => ({
  id: row.id as OratorId,
  targetType: row.target_type as ReportRecord["targetType"],
  targetId: row.target_id,
  reporterPrincipalId: row.reporter_principal_id as OratorId | null,
  reporterContact: row.reporter_contact,
  category: row.category as ReportRecord["category"],
  details: row.details,
  status: row.status as ReportStatus,
  resolution: row.resolution,
  reviewedBy: row.reviewed_by as OratorId | null,
  createdAt: row.created_at,
  reviewedAt: row.reviewed_at,
});

const toAction = (row: ActionRow): ModerationActionRecord => ({
  id: row.id as OratorId,
  targetType: row.target_type as ModerationActionRecord["targetType"],
  targetId: row.target_id,
  action: row.action as ModerationActionRecord["action"],
  reasonCode: row.reason_code,
  reasonText: row.reason_text,
  source: row.source as ModerationActionRecord["source"],
  reportId: row.report_id as OratorId | null,
  actorPrincipalId: row.actor_principal_id as OratorId | null,
  reversedAt: row.reversed_at,
  createdAt: row.created_at,
});

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

    /**
     * The queue, oldest first (SPEC §61.1).
     *
     * Ascending by id, which is creation order (§12.2): a report that has been waiting
     * longest is the one a moderator should see, and a queue sorted newest-first buries the
     * backlog it exists to drain. The cursor is the last id seen, like every other listing
     * here (§20.5) — an offset would repeat and drop rows as reports arrive underneath.
     */
    async listReports(status, limit, after, order = "oldest") {
      const clauses = [];
      const binds: unknown[] = [];
      if (status !== null) {
        clauses.push("status = ?");
        binds.push(status);
      }
      /*
       * The cursor compares in the direction the page runs.
       *
       * `id > ?` walking forwards and `id < ?` walking back. Getting this wrong does not
       * error — it returns the page you already read — which is why the comparison and the
       * sort are decided together, from one value, rather than in two places.
       */
      if (after !== null) {
        clauses.push(order === "oldest" ? "id > ?" : "id < ?");
        binds.push(after);
      }
      const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
      const direction = order === "oldest" ? "ASC" : "DESC";
      const { results } = await db
        .prepare(`SELECT * FROM reports${where} ORDER BY id ${direction} LIMIT ?`)
        .bind(...binds, limit)
        .all<ReportRow>();
      return results.map(toReport);
    },

    /** SPEC §61.1 — how many there are, so a page of fifty can say what it is fifty of. */
    async countReports(status) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = ?`)
        .bind(status)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    /**
     * SPEC §61.1 — what each queue entry is about, in one query per target type.
     *
     * Three queries at most, and usually one: a page of reports is nearly always articles.
     * Grouped rather than looped because the alternative is fifty round trips on a page a
     * moderator opens over and over.
     *
     * The article title comes from the published revision, falling back to the current one.
     * A report often names an article that has already been hidden, and a queue that cannot
     * say which article that was is a queue that has to be worked with two tabs open.
     */
    async describeTargets(targets) {
      const idsOf = (type: string): string[] => [
        ...new Set(targets.filter((one) => one.targetType === type).map((one) => one.targetId)),
      ];
      const holes = (ids: string[]) => ids.map(() => "?").join(", ");
      const found = new Map<string, TargetSummary>();

      const articles = idsOf("article");
      if (articles.length > 0) {
        const { results } = await db
          .prepare(
            `SELECT a.id, r.title
               FROM articles a
               LEFT JOIN revisions r
                      ON r.id = COALESCE(a.published_revision_id, a.current_revision_id)
              WHERE a.id IN (${holes(articles)})`,
          )
          .bind(...articles)
          .all<{ id: string; title: string | null }>();
        for (const row of results) {
          found.set(`article:${row.id}`, {
            targetType: "article",
            targetId: row.id,
            label: row.title,
            articleId: row.id,
          });
        }
      }

      const comments = idsOf("comment");
      if (comments.length > 0) {
        const { results } = await db
          .prepare(
            // The opening words, cut in SQL rather than in the Worker: a comment may be
            // §16.2's whole allowance, and none of it past the first line is a subject line.
            `SELECT id, article_id, substr(content_markdown, 1, 120) AS opening
               FROM comments WHERE id IN (${holes(comments)})`,
          )
          .bind(...comments)
          .all<{ id: string; article_id: string; opening: string | null }>();
        for (const row of results) {
          found.set(`comment:${row.id}`, {
            targetType: "comment",
            targetId: row.id,
            label: row.opening,
            articleId: row.article_id,
          });
        }
      }

      const principals = idsOf("principal");
      if (principals.length > 0) {
        const { results } = await db
          .prepare(
            `SELECT id, username, display_name FROM principals WHERE id IN (${holes(principals)})`,
          )
          .bind(...principals)
          .all<{ id: string; username: string; display_name: string | null }>();
        for (const row of results) {
          found.set(`principal:${row.id}`, {
            targetType: "principal",
            targetId: row.id,
            label: row.display_name ?? `@${row.username}`,
            articleId: null,
          });
        }
      }

      /*
       * Every target asked about comes back, described or not.
       *
       * A missing row means the target is gone — erased under §23.3, or a report naming an id
       * that never existed — and the queue still has to render that line. Dropping it here
       * would make a report disappear from the page while staying open in the table.
       */
      return targets.map(
        (target) =>
          found.get(`${target.targetType}:${target.targetId}`) ?? {
            ...target,
            label: null,
            articleId: null,
          },
      );
    },

    async listRecentActions(limit, before) {
      // Keyset on the id, which is time-ordered (§12.2), so paging back through the log costs
      // an index seek rather than an offset scan.
      const where = before === null ? "" : " WHERE id < ?";
      const binds = before === null ? [limit] : [before, limit];
      const { results } = await db
        .prepare(`SELECT * FROM moderation_actions${where} ORDER BY id DESC LIMIT ?`)
        .bind(...binds)
        .all<ActionRow>();
      return results.map(toAction);
    },

    async findReport(id) {
      const row = await db.prepare(`SELECT * FROM reports WHERE id = ?`).bind(id).first<ReportRow>();
      return row === null ? null : toReport(row);
    },

    /**
     * §34.3 applied to the queue: the move happens only from the state the caller saw.
     *
     * Two moderators opening the same queue is the ordinary case, not a race worth avoiding
     * by locking. The `IN (...)` guard makes the second write a no-op the service can
     * notice, rather than an overwrite of the first moderator's resolution.
     */
    setReportStatus(id, status, expected, reviewedBy, resolution, at) {
      const placeholders = expected.map(() => "?").join(", ");
      return asWrite(
        db
          .prepare(
            `UPDATE reports
                SET status = ?, reviewed_by = ?, resolution = ?, reviewed_at = ?
              WHERE id = ? AND status IN (${placeholders})`,
          )
          .bind(status, reviewedBy, resolution, at, id, ...expected),
      );
    },

    insertAction(action: NewModerationAction) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO moderation_actions
               (id, target_type, target_id, action, reason_code, reason_text, source,
                report_id, actor_principal_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            action.id,
            action.targetType,
            action.targetId,
            action.action,
            action.reasonCode,
            action.reasonText,
            action.source,
            action.reportId,
            action.actorPrincipalId,
            action.createdAt,
          ),
      );
    },

    async listActions(targetType, targetId, limit) {
      const { results } = await db
        .prepare(
          `SELECT * FROM moderation_actions
            WHERE target_type = ? AND target_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .bind(targetType, targetId, limit)
        .all<ActionRow>();
      return results.map(toAction);
    },

    reverseAction(id, at) {
      // Only once: a reversal that could be applied twice would make the history ambiguous
      // about which restore undid which action.
      return asWrite(
        db
          .prepare(`UPDATE moderation_actions SET reversed_at = ? WHERE id = ? AND reversed_at IS NULL`)
          .bind(at, id),
      );
    },

    async findLastAction(targetType, targetId) {
      const row = await db
        .prepare(
          `SELECT * FROM moderation_actions
            WHERE target_type = ? AND target_id = ? AND reversed_at IS NULL
            ORDER BY id DESC LIMIT 1`,
        )
        .bind(targetType, targetId)
        .first<ActionRow>();
      return row === null ? null : toAction(row);
    },
  };
}
