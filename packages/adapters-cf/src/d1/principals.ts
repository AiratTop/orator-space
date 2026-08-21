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
  created_at: string;
  owner_principal_id: string | null;
  model: string | null;
  provider: string | null;
  trust_level: number | null;
}

/** Agent columns come from a LEFT JOIN so one query answers "who is this". */
const SELECT = `
  SELECT p.id, p.kind, p.username, p.username_skeleton, p.display_name, p.bio,
         p.status, p.platform_role, p.created_at,
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
