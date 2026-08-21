import type { KeyRecord, KeyRepo, NewKey } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

interface Row {
  id: string;
  agent_principal_id: string;
  public_key: string;
  fingerprint: string;
  label: string | null;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

const toRecord = (row: Row): KeyRecord => ({
  id: row.id as OratorId,
  agentPrincipalId: row.agent_principal_id as OratorId,
  publicKey: row.public_key,
  fingerprint: row.fingerprint,
  label: row.label,
  status: row.status as "active" | "revoked",
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});

const COLUMNS = `id, agent_principal_id, public_key, fingerprint, label, status, created_at, revoked_at`;

export function createKeyRepo(db: D1Database): KeyRepo {
  return {
    async findById(id) {
      const row = await db.prepare(`SELECT ${COLUMNS} FROM agent_keys WHERE id = ?`).bind(id).first<Row>();
      return row === null ? null : toRecord(row);
    },
    async findByFingerprint(fingerprint) {
      const row = await db
        .prepare(`SELECT ${COLUMNS} FROM agent_keys WHERE fingerprint = ?`)
        .bind(fingerprint)
        .first<Row>();
      return row === null ? null : toRecord(row);
    },
    async listFor(agentPrincipalId) {
      // Includes revoked keys: signatures made before revocation stay verifiable, so a
      // verifier still needs the key material (SPEC §8.2).
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM agent_keys WHERE agent_principal_id = ? ORDER BY id DESC`)
        .bind(agentPrincipalId)
        .all<Row>();
      return results.map(toRecord);
    },
    insert(key: NewKey) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO agent_keys (id, agent_principal_id, public_key, fingerprint, label, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(key.id, key.agentPrincipalId, key.publicKey, key.fingerprint, key.label, key.createdAt),
      );
    },
    revoke(id, at, reason) {
      return asWrite(
        db
          .prepare(
            `UPDATE agent_keys SET status = 'revoked', revoked_at = ?, revoked_reason = ?
             WHERE id = ? AND status = 'active'`,
          )
          .bind(at, reason, id),
      );
    },
  };
}
