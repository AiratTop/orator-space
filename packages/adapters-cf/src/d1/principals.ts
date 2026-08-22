import type { NewAgent, NewPrincipal, PrincipalRecord, PrincipalRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

interface Row {
  id: string;
  kind: string;
  username: string;
  username_skeleton: string;
  display_name: string | null;
  bio: string | null;
  status: string;
  platform_role: string;
  system_account: number;
  created_at: string;
  owner_principal_id: string | null;
  model: string | null;
  provider: string | null;
  trust_level: number | null;
}

/** Agent columns come from a LEFT JOIN so one query answers "who is this". */
const SELECT = `
  SELECT p.id, p.kind, p.username, p.username_skeleton, p.display_name, p.bio,
         p.status, p.platform_role, p.system_account, p.created_at,
         a.owner_principal_id, a.model, a.provider, a.trust_level
    FROM principals p
    LEFT JOIN agents a ON a.principal_id = p.id`;

function toRecord(row: Row | null): PrincipalRecord | null {
  if (row === null) return null;
  const record: PrincipalRecord = {
    id: row.id as OratorId,
    kind: row.kind as "human" | "agent",
    username: row.username,
    usernameSkeleton: row.username_skeleton,
    displayName: row.display_name,
    bio: row.bio,
    status: row.status as PrincipalRecord["status"],
    platformRole: row.platform_role as PrincipalRecord["platformRole"],
    systemAccount: row.system_account === 1,
    createdAt: row.created_at,
  };
  if (row.owner_principal_id !== null) {
    record.ownerPrincipalId = row.owner_principal_id as OratorId;
    record.model = row.model;
    record.provider = row.provider;
    record.trustLevel = row.trust_level ?? 0;
  }
  return record;
}

export function createPrincipalRepo(db: D1Database): PrincipalRepo {
  return {
    async findById(id) {
      return toRecord(await db.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first<Row>());
    },
    async findByUsername(username) {
      return toRecord(await db.prepare(`${SELECT} WHERE p.username = ?`).bind(username).first<Row>());
    },
    async findBySkeleton(skeleton) {
      return toRecord(await db.prepare(`${SELECT} WHERE p.username_skeleton = ?`).bind(skeleton).first<Row>());
    },
    async countAgentsOwnedBy(ownerPrincipalId) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM agents WHERE owner_principal_id = ?`)
        .bind(ownerPrincipalId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async listAgentsOwnedBy(ownerPrincipalId) {
      const { results } = await db
        .prepare(`${SELECT} WHERE a.owner_principal_id = ?`)
        .bind(ownerPrincipalId)
        .all<Row>();
      return results.map((row) => toRecord(row)!).filter((record) => record !== null);
    },

    blankHumanAccount(principalId, _at) {
      // §23.5 — the email is the personal datum; `locale` goes with it because it is one
      // more thing about a person that nothing needs any more. The row stays: it is a
      // foreign key target for articles, comments, edges and audit entries.
      return asWrite(
        db
          .prepare(
            `UPDATE human_accounts SET email = NULL, email_verified_at = NULL, locale = NULL
              WHERE principal_id = ?`,
          )
          .bind(principalId),
      );
    },

    insertPrincipal(principal: NewPrincipal) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO principals
               (id, kind, username, username_skeleton, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            principal.id,
            principal.kind,
            principal.username,
            principal.usernameSkeleton,
            principal.displayName,
            principal.createdAt,
            principal.createdAt,
          ),
      );
    },

    insertHumanAccount(principalId, email, createdAt) {
      return asWrite(
        db
          .prepare(`INSERT INTO human_accounts (principal_id, email, created_at) VALUES (?, ?, ?)`)
          .bind(principalId, email, createdAt),
      );
    },

    setStatus(principalId, status, at) {
      return asWrite(
        db
          .prepare(`UPDATE principals SET status = ?, updated_at = ? WHERE id = ?`)
          .bind(status, at, principalId),
      );
    },

    updateProfile(principalId, fields, at) {
      const assignments: string[] = [];
      const binds: unknown[] = [];
      if (fields.displayName !== undefined) {
        assignments.push("display_name = ?");
        binds.push(fields.displayName);
      }
      if (fields.bio !== undefined) {
        assignments.push("bio = ?");
        binds.push(fields.bio);
      }
      assignments.push("updated_at = ?");
      binds.push(at, principalId);
      return asWrite(
        db.prepare(`UPDATE principals SET ${assignments.join(", ")} WHERE id = ?`).bind(...binds),
      );
    },

    insertAgent(agent: NewAgent) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO agents (principal_id, owner_principal_id, model, provider, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(agent.principalId, agent.ownerPrincipalId, agent.model, agent.provider, agent.createdAt),
      );
    },
  };
}
