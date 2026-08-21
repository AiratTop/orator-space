import type { NewToken, TokenRecord, TokenRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

interface Row {
  id: string;
  principal_id: string;
  name: string;
  scopes: string;
  prefix: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

const toRecord = (row: Row): TokenRecord => ({
  id: row.id as OratorId,
  principalId: row.principal_id as OratorId,
  name: row.name,
  scopes: JSON.parse(row.scopes) as string[],
  prefix: row.prefix,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const COLUMNS = `id, principal_id, name, scopes, prefix, expires_at, revoked_at, created_at, last_used_at`;

export function createTokenRepo(db: D1Database): TokenRepo {
  return {
    async findByHash(tokenHash) {
      const row = await db
        .prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE token_hash = ?`)
        .bind(tokenHash)
        .first<Row>();
      return row === null ? null : toRecord(row);
    },
    async listFor(principalId) {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE principal_id = ? ORDER BY id DESC`)
        .bind(principalId)
        .all<Row>();
      return results.map(toRecord);
    },
    insert(token: NewToken) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO api_tokens (id, principal_id, name, token_hash, prefix, scopes, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            token.id,
            token.principalId,
            token.name,
            token.tokenHash,
            token.prefix,
            JSON.stringify(token.scopes),
            token.expiresAt,
            token.createdAt,
          ),
      );
    },
    revoke(id, at) {
      // Conditional, so revoking twice is a no-op rather than a silent overwrite of the
      // original revocation time (SPEC §34.3 uses the same shape for concurrency).
      return asWrite(
        db
          .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
          .bind(at, id),
      );
    },
    touch(id, at) {
      return asWrite(db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).bind(at, id));
    },
  };
}
