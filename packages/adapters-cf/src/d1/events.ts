import type { EventRepo, IdempotencyRecord, IdempotencyRepo, NewEvent } from "@orator/core/ports";
import { readVersioned, type OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

interface EventRow {
  id: string;
  type: string;
  actor_principal_id: string | null;
  subject_type: string;
  subject_id: string;
  audience_principal_id: string | null;
  visibility: string;
  payload_json: string | null;
  created_at: string;
}

const toEvent = (row: EventRow): NewEvent => ({
  id: row.id as OratorId,
  type: row.type,
  actorPrincipalId: row.actor_principal_id as OratorId | null,
  subjectType: row.subject_type as NewEvent["subjectType"],
  subjectId: row.subject_id,
  audiencePrincipalId: row.audience_principal_id as OratorId | null,
  visibility: row.visibility as "public" | "private",
  payload: (readVersioned(row.payload_json) ?? { schema_version: 0 }) as NewEvent["payload"],
  createdAt: row.created_at,
});

const COLUMNS = `id, type, actor_principal_id, subject_type, subject_id,
                 audience_principal_id, visibility, payload_json, created_at`;

export function createEventRepo(db: D1Database): EventRepo {
  return {
    insert(event) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO events
               (id, type, actor_principal_id, subject_type, subject_id,
                audience_principal_id, visibility, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.type,
            event.actorPrincipalId,
            event.subjectType,
            event.subjectId,
            event.audiencePrincipalId,
            event.visibility,
            JSON.stringify(event.payload),
            event.createdAt,
          ),
      );
    },

    /**
     * Cursor pagination on the id itself (SPEC §20.5). Identifiers are monotonic, so the
     * id is the cursor — no separate column, and no offset, which would skip or repeat
     * rows whenever something is inserted mid-scan.
     */
    async listForAudience(principalId, since, limit) {
      const { results } =
        since === null
          ? await db
              .prepare(
                `SELECT ${COLUMNS} FROM events WHERE audience_principal_id = ? ORDER BY id ASC LIMIT ?`,
              )
              .bind(principalId, limit)
              .all<EventRow>()
          : await db
              .prepare(
                `SELECT ${COLUMNS} FROM events
                  WHERE audience_principal_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
              )
              .bind(principalId, since, limit)
              .all<EventRow>();
      return results.map(toEvent);
    },

    async listForSubject(subjectType, subjectId, limit) {
      const { results } = await db
        .prepare(
          `SELECT ${COLUMNS} FROM events
            WHERE subject_type = ? AND subject_id = ? AND visibility = 'public'
            ORDER BY id ASC LIMIT ?`,
        )
        .bind(subjectType, subjectId, limit)
        .all<EventRow>();
      return results.map(toEvent);
    },
  };
}

interface IdempotencyRow {
  key: string;
  principal_id: string;
  endpoint: string;
  request_hash: string;
  status: string;
  response_status: number | null;
  response_json: string | null;
  created_at: string;
}

export function createIdempotencyRepo(db: D1Database): IdempotencyRepo {
  return {
    async deleteBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `DELETE FROM idempotency_keys WHERE rowid IN (
             SELECT rowid FROM idempotency_keys WHERE created_at < ? LIMIT ?
           )`,
        )
        .bind(cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },

    async find(principalId, key) {
      const row = await db
        .prepare(`SELECT * FROM idempotency_keys WHERE principal_id = ? AND key = ?`)
        .bind(principalId, key)
        .first<IdempotencyRow>();
      if (row === null) return null;
      return {
        key: row.key,
        principalId: row.principal_id,
        endpoint: row.endpoint,
        requestHash: row.request_hash,
        status: row.status as IdempotencyRecord["status"],
        responseStatus: row.response_status,
        responseJson: row.response_json,
        createdAt: row.created_at,
      };
    },

    /**
     * `INSERT OR IGNORE` rather than a check followed by an insert: two retries of the
     * same request arrive together, and only the database can decide which one proceeds.
     * Zero rows changed means the other one won.
     */
    claim(record) {
      return asWrite(
        db
          .prepare(
            `INSERT OR IGNORE INTO idempotency_keys
               (principal_id, key, endpoint, request_hash, status, created_at)
             VALUES (?, ?, ?, ?, 'in_progress', ?)`,
          )
          .bind(record.principalId, record.key, record.endpoint, record.requestHash, record.createdAt),
      );
    },

    complete(principalId, key, status, body) {
      return asWrite(
        db
          .prepare(
            `UPDATE idempotency_keys SET status = 'completed', response_status = ?, response_json = ?
              WHERE principal_id = ? AND key = ?`,
          )
          .bind(status, body, principalId, key),
      );
    },

    /** Frees the key so a retry is not permanently blocked by a transient failure. */
    release(principalId, key) {
      return asWrite(
        db
          .prepare(`DELETE FROM idempotency_keys WHERE principal_id = ? AND key = ? AND status = 'in_progress'`)
          .bind(principalId, key),
      );
    },
  };
}
