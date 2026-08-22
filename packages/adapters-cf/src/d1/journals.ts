import type {
  AuditEntry,
  AuditRepo,
  EventBus,
  OutboxEntry,
  OutboxRepo,
  PendingOutboxRow,
} from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/** SPEC §62 — restricted, security-relevant, never the public activity feed. */
export function createAuditRepo(db: D1Database): AuditRepo {
  return {
    /**
     * SPEC §23.4 — the identifying columns are cleared; the record is not.
     *
     * `ip_hash` and `user_agent` are what make a row about a person rather than about an
     * action, and `actor_principal_id` is a foreign key into a table an account closure may
     * have emptied (§23.5). What stays is what an investigation needs: what happened, to
     * what, and whether it succeeded.
     */
    async pseudonymiseBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `UPDATE audit_log
              SET ip_hash = NULL, user_agent = NULL, actor_principal_id = NULL
            WHERE id IN (
              SELECT id FROM audit_log
               WHERE created_at < ? AND (ip_hash IS NOT NULL OR user_agent IS NOT NULL
                                          OR actor_principal_id IS NOT NULL)
               LIMIT ?
            )`,
        )
        .bind(cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },

    record(entry: AuditEntry) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO audit_log
               (id, actor_principal_id, actor_token_id, action, target_type, target_id,
                outcome, reason, ip_hash, user_agent, request_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.id,
            entry.actorPrincipalId,
            entry.actorTokenId,
            entry.action,
            entry.targetType,
            entry.targetId,
            entry.outcome,
            entry.reason,
            entry.ipHash,
            entry.userAgent,
            entry.requestId,
            entry.createdAt,
          ),
      );
    },
  };
}

interface PendingRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  request_id: string | null;
  created_at: string;
  attempts: number;
}

/**
 * SPEC §35 — the row goes into the same commit as the change it describes. Sending to the
 * queue after the commit is not atomic with it, and the gap is invisible: the article
 * publishes, the event is lost, and nothing indexes, purges or notifies.
 */
export function createOutboxRepo(db: D1Database): OutboxRepo {
  return {
    async deleteSentBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `DELETE FROM outbox WHERE id IN (
             SELECT id FROM outbox WHERE status = 'sent' AND created_at < ? LIMIT ?
           )`,
        )
        .bind(cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },

    enqueue(entry: OutboxEntry) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO outbox
               (id, event_type, aggregate_type, aggregate_id, payload_json, request_id,
                created_at, next_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            entry.id,
            entry.eventType,
            entry.aggregateType,
            entry.aggregateId,
            JSON.stringify(entry.payload),
            entry.requestId,
            entry.createdAt,
            entry.createdAt,
          ),
      );
    },

    async listPending(now, limit) {
      const { results } = await db
        .prepare(
          `SELECT id, event_type, aggregate_type, aggregate_id, payload_json, request_id,
                  created_at, attempts
             FROM outbox
            WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY id ASC
            LIMIT ?`,
        )
        .bind(now, limit)
        .all<PendingRow>();

      return results.map(
        (row): PendingOutboxRow => ({
          id: row.id as OratorId,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: JSON.parse(row.payload_json) as PendingOutboxRow["payload"],
          requestId: row.request_id,
          createdAt: row.created_at,
          attempts: row.attempts,
        }),
      );
    },

    markSent(ids, at) {
      // D1 allows 100 bound parameters per statement (ADR 0001), so the drain batch stays
      // well under that; the placeholder list is built to match the input exactly.
      const placeholders = ids.map(() => "?").join(", ");
      return asWrite(
        db
          .prepare(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id IN (${placeholders})`)
          .bind(at, ...ids),
      );
    },

    markFailed(id, error, nextAttemptAt) {
      return asWrite(
        db
          .prepare(
            `UPDATE outbox
                SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .bind(error, nextAttemptAt, id),
      );
    },

    async pendingStats() {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox WHERE status = 'pending'`)
        .first<{ n: number; oldest: string | null }>();
      return { count: row?.n ?? 0, oldestCreatedAt: row?.oldest ?? null };
    },
  };
}

/**
 * Delivers outbox rows to a Cloudflare Queue (SPEC §35.3).
 *
 * Payloads carry identifiers, never content: queue messages cap at 128 KB (ADR 0001), and
 * a consumer that needs the body reads it from storage, where it is authoritative anyway.
 */
export function createQueueEventBus(queue: Queue): EventBus {
  return {
    async publish(entries) {
      if (entries.length === 0) return;
      await queue.sendBatch(
        entries.map((entry) => ({
          body: {
            id: entry.id,
            type: entry.eventType,
            aggregate_type: entry.aggregateType,
            aggregate_id: entry.aggregateId,
            request_id: entry.requestId,
            created_at: entry.createdAt,
            payload: entry.payload,
          },
        })),
      );
    },
  };
}
