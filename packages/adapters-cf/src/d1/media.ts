import type { MediaRecord, MediaRepo, NewMedia, StoredMedia } from "@orator/core/ports";
import { asWrite } from "./database.js";

/** SPEC §21 over D1. The bytes are the media store's problem; this is the record. */

interface Row {
  id: string;
  owner_principal_id: string;
  status: string;
  kind: string;
  storage_key: string | null;
  content_type: string | null;
  byte_size: number | null;
  checksum_sha256: string | null;
  alt_text: string | null;
  source: string;
  generation_metadata: string | null;
  created_at: string;
  finalized_at: string | null;
}

const toRecord = (row: Row): MediaRecord => ({
  id: row.id as MediaRecord["id"],
  ownerPrincipalId: row.owner_principal_id as MediaRecord["ownerPrincipalId"],
  status: row.status as MediaRecord["status"],
  kind: row.kind as MediaRecord["kind"],
  storageKey: row.storage_key,
  contentType: row.content_type,
  byteSize: row.byte_size,
  checksumSha256: row.checksum_sha256,
  altText: row.alt_text,
  source: row.source as MediaRecord["source"],
  generationMetadata:
    row.generation_metadata === null
      ? null
      : (JSON.parse(row.generation_metadata) as Record<string, unknown>),
  createdAt: row.created_at,
  finalizedAt: row.finalized_at,
});

export function createMediaRepo(db: D1Database): MediaRepo {
  return {
    async listStalePending(cutoff, limit) {
      const { results } = await db
        .prepare(
          `SELECT id FROM media WHERE status = 'pending' AND created_at < ? ORDER BY id LIMIT ?`,
        )
        .bind(cutoff, limit)
        .all<{ id: string }>();
      return results.map((row) => row.id);
    },

    deleteRecords(ids) {
      const placeholders = ids.map(() => "?").join(", ");
      return asWrite(db.prepare(`DELETE FROM media WHERE id IN (${placeholders})`).bind(...ids));
    },

    async findById(id: string): Promise<MediaRecord | null> {
      const row = await db.prepare(`SELECT * FROM media WHERE id = ?`).bind(id).first<Row>();
      return row === null ? null : toRecord(row);
    },

    insert(media: NewMedia) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO media
               (id, owner_principal_id, status, kind, alt_text, source, generation_metadata, created_at)
             VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
          )
          .bind(
            media.id,
            media.ownerPrincipalId,
            media.kind,
            media.altText,
            media.source,
            media.generationMetadata === null ? null : JSON.stringify(media.generationMetadata),
            media.createdAt,
          ),
      );
    },

    /**
     * `WHERE status = 'pending'` is the concurrency control (§34.3).
     *
     * Two uploads racing the same record would otherwise both write bytes and both claim
     * the row; here the second changes nothing, and the zero row count says so. The read
     * that preceded it in the service is an early refusal, not the guarantee.
     */
    markReady(id: string, stored: StoredMedia) {
      return asWrite(
        db
          .prepare(
            `UPDATE media
                SET status = 'ready', storage_key = ?, content_type = ?, byte_size = ?,
                    checksum_sha256 = ?, finalized_at = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .bind(
            stored.storageKey,
            stored.contentType,
            stored.byteSize,
            stored.checksumSha256,
            stored.finalizedAt,
            id,
          ),
      );
    },

    /**
     * A refused upload leaves evidence rather than rubbish. `finalized_at` is set because
     * the record is finished — the sweeper (§23.4) collects `pending` rows, and a rejected
     * one is not waiting for anything.
     */
    markRejected(id: string, at: string) {
      return asWrite(
        db
          .prepare(
            `UPDATE media SET status = 'rejected', finalized_at = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .bind(at, id),
      );
    },
  };
}
