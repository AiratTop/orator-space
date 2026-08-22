import type { CredentialRecord, CredentialRepo, SessionRecord, SessionRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/** SPEC §42.2, §9.1 over D1. */

interface CredentialRow {
  id: string;
  principal_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
  aaguid: string | null;
  label: string | null;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

const toCredential = (row: CredentialRow): CredentialRecord => ({
  id: row.id as OratorId,
  principalId: row.principal_id as OratorId,
  credentialId: row.credential_id,
  publicKey: row.public_key,
  signCount: row.sign_count,
  transports: row.transports,
  aaguid: row.aaguid,
  label: row.label,
  backedUp: row.backed_up === 1,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

export function createCredentialRepo(db: D1Database): CredentialRepo {
  return {
    async findByCredentialId(credentialId) {
      const row = await db
        .prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`)
        .bind(credentialId)
        .first<CredentialRow>();
      return row === null ? null : toCredential(row);
    },

    async listFor(principalId) {
      const { results } = await db
        .prepare(`SELECT * FROM webauthn_credentials WHERE principal_id = ? ORDER BY created_at`)
        .bind(principalId)
        .all<CredentialRow>();
      return results.map(toCredential);
    },

    insert(credential) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO webauthn_credentials
               (id, principal_id, credential_id, public_key, sign_count, transports,
                aaguid, label, backed_up, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            credential.id,
            credential.principalId,
            credential.credentialId,
            credential.publicKey,
            credential.signCount,
            credential.transports,
            credential.aaguid,
            credential.label,
            credential.backedUp ? 1 : 0,
            credential.createdAt,
          ),
      );
    },

    recordUse(id, signCount, at) {
      return asWrite(
        db
          .prepare(`UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?`)
          .bind(signCount, at, id),
      );
    },
    deleteAllFor(principalId) {
      return asWrite(db.prepare(`DELETE FROM webauthn_credentials WHERE principal_id = ?`).bind(principalId));
    },
  };
}

interface SessionRow {
  id: string;
  principal_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export function createSessionRepo(db: D1Database): SessionRepo {
  return {
    async findByHash(tokenHash) {
      const row = await db
        .prepare(
          `SELECT id, principal_id, created_at, last_seen_at, expires_at, revoked_at
             FROM sessions WHERE token_hash = ?`,
        )
        .bind(tokenHash)
        .first<SessionRow>();
      return row === null
        ? null
        : ({
            id: row.id as OratorId,
            principalId: row.principal_id as OratorId,
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
          } satisfies SessionRecord);
    },

    insert(session) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO sessions
               (id, principal_id, token_hash, user_agent, ip_hash, created_at, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            session.id,
            session.principalId,
            session.tokenHash,
            session.userAgent,
            session.ipHash,
            session.createdAt,
            session.lastSeenAt,
            session.expiresAt,
          ),
      );
    },

    touch(id, at) {
      return asWrite(db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(at, id));
    },

    revoke(id, at) {
      return asWrite(
        db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(at, id),
      );
    },

    /** SPEC §23.5 — closing an account revokes every session it has, not only this one. */
    revokeAllFor(principalId, at) {
      return asWrite(
        db
          .prepare(`UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL`)
          .bind(at, principalId),
      );
    },
  };
}
