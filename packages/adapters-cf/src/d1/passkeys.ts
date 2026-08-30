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
    deleteOne(id, principalId) {
      return asWrite(
        db
          .prepare(`DELETE FROM webauthn_credentials WHERE id = ? AND principal_id = ?`)
          .bind(id, principalId),
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

    async listFor(principalId) {
      // Unrevoked only. Expiry is left to the caller, which holds the clock — an adapter
      // reading the wall clock is an adapter no test can move time in (§68).
      // `id DESC` is newest first, ids being time-ordered (§12.2).
      const { results } = await db
        .prepare(
          `SELECT id, principal_id, user_agent, created_at, last_seen_at, expires_at, revoked_at
             FROM sessions
            WHERE principal_id = ? AND revoked_at IS NULL
            ORDER BY id DESC
            LIMIT 50`,
        )
        .bind(principalId)
        .all<SessionRow & { user_agent: string | null }>();
      return results.map((row) => ({
        id: row.id as OratorId,
        principalId: row.principal_id as OratorId,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      }));
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

    /**
     * SPEC §23.4 — sessions that are dead by either measure.
     *
     * One cutoff bound twice rather than two parameters: "revoked before then" and "expired
     * before then" are the same question asked of two columns, and a row satisfying either
     * is a row `findByHash` would refuse and `listFor` would hide.
     */
    async deleteDeadBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `DELETE FROM sessions
            WHERE id IN (
              SELECT id FROM sessions
               WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?
               LIMIT ?
            )`,
        )
        .bind(cutoff, cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },
  };
}
