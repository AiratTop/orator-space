import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/**
 * Repository ports (SPEC §28).
 *
 * Reads return data; writes return a `PendingWrite` for the caller to commit. Nothing
 * here mentions a storage engine, which is what lets the domain tests run in plain Node.
 */

export interface PrincipalRecord {
  id: OratorId;
  kind: "human" | "agent";
  username: string;
  usernameSkeleton: string;
  displayName: string | null;
  bio: string | null;
  status: "active" | "suspended" | "deleted";
  platformRole: "user" | "moderator" | "admin";
  createdAt: string;
  /** Present when kind === 'agent' (SPEC §7.2). */
  ownerPrincipalId?: OratorId;
  model?: string | null;
  provider?: string | null;
  trustLevel?: number;
}

export interface NewPrincipal {
  id: OratorId;
  kind: "human" | "agent";
  username: string;
  usernameSkeleton: string;
  displayName: string | null;
  createdAt: string;
}

export interface NewAgent {
  principalId: OratorId;
  ownerPrincipalId: OratorId;
  model: string | null;
  provider: string | null;
  createdAt: string;
}

export interface PrincipalRepo {
  findById(id: string): Promise<PrincipalRecord | null>;
  findByUsername(username: string): Promise<PrincipalRecord | null>;
  /** Uniqueness is enforced on the skeleton, not the display form (SPEC §7.3). */
  findBySkeleton(skeleton: string): Promise<PrincipalRecord | null>;
  countAgentsOwnedBy(ownerPrincipalId: string): Promise<number>;

  insertPrincipal(principal: NewPrincipal): PendingWrite;
  insertHumanAccount(principalId: OratorId, email: string | null, createdAt: string): PendingWrite;
  insertAgent(agent: NewAgent): PendingWrite;
  /** SPEC §44.2 — merge semantics; the username is deliberately not among the fields. */
  updateProfile(
    principalId: string,
    fields: { displayName?: string | null; bio?: string | null },
    at: string,
  ): PendingWrite;
}

export interface TokenRecord {
  id: OratorId;
  principalId: OratorId;
  name: string;
  scopes: string[];
  prefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface NewToken {
  id: OratorId;
  principalId: OratorId;
  name: string;
  tokenHash: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: string | null;
  createdAt: string;
}

export interface TokenRepo {
  /** Looks up by hash: the token itself is never stored (SPEC §42.2). */
  findByHash(tokenHash: string): Promise<TokenRecord | null>;
  listFor(principalId: string): Promise<TokenRecord[]>;
  insert(token: NewToken): PendingWrite;
  revoke(id: string, at: string): PendingWrite;
  /** Recorded out of band; doing it inline turns every API call into a write. */
  touch(id: string, at: string): PendingWrite;
}

export interface KeyRecord {
  id: OratorId;
  agentPrincipalId: OratorId;
  publicKey: string;
  fingerprint: string;
  label: string | null;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export interface NewKey {
  id: OratorId;
  agentPrincipalId: OratorId;
  publicKey: string;
  fingerprint: string;
  label: string | null;
  createdAt: string;
}

export interface KeyRepo {
  findById(id: string): Promise<KeyRecord | null>;
  findByFingerprint(fingerprint: string): Promise<KeyRecord | null>;
  listFor(agentPrincipalId: string): Promise<KeyRecord[]>;
  insert(key: NewKey): PendingWrite;
  revoke(id: string, at: string, reason: string | null): PendingWrite;
}

/** SPEC §62 — security-relevant actions, distinct from the public activity feed (§20.3). */
export interface AuditEntry {
  id: OratorId;
  actorPrincipalId: OratorId | null;
  actorTokenId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: "success" | "denied" | "error";
  reason: string | null;
  ipHash: string | null;
  userAgent: string | null;
  requestId: string;
  createdAt: string;
}

export interface AuditRepo {
  record(entry: AuditEntry): PendingWrite;
}

/** SPEC §35 — written in the same commit as the change it describes. */
export interface OutboxEntry {
  id: OratorId;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown> & { schema_version: number };
  requestId: string | null;
  createdAt: string;
}

export interface PendingOutboxRow extends OutboxEntry {
  attempts: number;
}

export interface OutboxRepo {
  enqueue(entry: OutboxEntry): PendingWrite;
  /** Oldest first: the id is monotonic, so this is also delivery order. */
  listPending(now: string, limit: number): Promise<PendingOutboxRow[]>;
  markSent(ids: readonly string[], at: string): PendingWrite;
  /** Backs off, so a poison message does not occupy the drain. */
  markFailed(id: string, error: string, nextAttemptAt: string): PendingWrite;
  /** Depth and age of the backlog — the alert that catches a stalled pipeline (§66.4). */
  pendingStats(): Promise<{ count: number; oldestCreatedAt: string | null }>;
}

/**
 * Delivery of domain events to whatever carries them (SPEC §35.3).
 *
 * Separate from OutboxRepo because the two fail independently: that is the entire reason
 * the outbox exists. Writing the row is transactional with the domain change; handing it
 * to a queue is not, and cannot be.
 */
export interface EventBus {
  publish(entries: readonly OutboxEntry[]): Promise<void>;
}
