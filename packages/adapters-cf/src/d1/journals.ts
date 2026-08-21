import type { AuditEntry, AuditRepo, OutboxEntry, OutboxRepo } from "@orator/core/ports";
import { asWrite } from "./database.js";

/** SPEC §62 — restricted, security-relevant, never the public activity feed. */
export function createAuditRepo(db: D1Database): AuditRepo {
  return {
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

/**
 * SPEC §35 — the row goes into the same commit as the change it describes. Sending to the
 * queue after the commit is not atomic with it, and the gap is invisible: the article
 * publishes, the event is lost, and nothing indexes, purges or notifies.
 */
export function createOutboxRepo(db: D1Database): OutboxRepo {
  return {
    enqueue(entry: OutboxEntry) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO outbox
               (id, event_type, aggregate_type, aggregate_id, payload_json, request_id, created_at, next_attempt_at)
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
  };
}
