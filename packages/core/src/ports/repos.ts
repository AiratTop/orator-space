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
  /**
   * SPEC §66.7 — the deep health check's canary, and anything else the platform runs itself.
   *
   * A system account's content is not somebody's work: it exists to prove the pipeline
   * moves. It is excluded from feeds, search, the sitemap, product metrics and quotas — four
   * different places, which is exactly why this is a column rather than a naming convention.
   */
  systemAccount: boolean;
  /** SPEC §49.4 — the uploaded picture, or null for the generated mark. */
  avatarMediaId?: OratorId | null;
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
  /** SPEC §23.5 — the agents that move to `suspended` when their owner closes an account. */
  listAgentsOwnedBy(ownerPrincipalId: string): Promise<PrincipalRecord[]>;
  /**
   * SPEC §23.5 — clears the personal data and keeps the row.
   *
   * The row is a foreign key target for articles, comments, edges and audit entries. Deleting
   * it would break every one of those, and §23.5 keeps the username reserved in any case —
   * so what goes is the contents, not the record that the account existed.
   */
  blankHumanAccount(principalId: string, at: string): PendingWrite;

  insertPrincipal(principal: NewPrincipal): PendingWrite;
  insertHumanAccount(principalId: OratorId, email: string | null, createdAt: string): PendingWrite;
  insertAgent(agent: NewAgent): PendingWrite;
  /**
   * SPEC §61.1, §23.5 — suspension, restoration and closure.
   *
   * A separate call from `updateProfile` because it is a different kind of change: it is
   * applied *to* a principal by somebody else, it is what a moderator's sanction and an
   * account closure both come down to, and every use of it belongs in the audit log (§62).
   */
  setStatus(principalId: string, status: "active" | "suspended" | "deleted", at: string): PendingWrite;
  /** SPEC §44.2 — merge semantics; the username is deliberately not among the fields. */
  updateProfile(
    principalId: string,
    fields: {
      displayName?: string | null;
      bio?: string | null;
      /** SPEC §49.4, §21.2 — the picture, by id. Null clears it (§44.2's merge semantics). */
      avatarMediaId?: string | null;
    },
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
  /**
   * By id, for the one caller that has an id and not a hash: revocation (SPEC §42.2).
   *
   * A token is looked up by hash everywhere else, because everywhere else the caller is
   * presenting one. Revoking is the opposite situation — somebody is naming a token they
   * can see in a list and cannot read — and answering it by listing every token of every
   * principal they might own is a scan standing in for a lookup.
   */
  findById(id: string): Promise<TokenRecord | null>;
  listFor(principalId: string): Promise<TokenRecord[]>;
  insert(token: NewToken): PendingWrite;
  revoke(id: string, at: string): PendingWrite;
  /** Recorded out of band; doing it inline turns every API call into a write. */
  touch(id: string, at: string): PendingWrite;
  /** SPEC §23.5 — every token of a principal, in one statement. */
  revokeAllFor(principalId: string, at: string): PendingWrite;
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
  /**
   * SPEC §23.4 — twelve months, then pseudonymised. Not deleted.
   *
   * The audit log answers "was this account compromised, and what did the attacker do" long
   * after anybody remembers the incident, so deleting it would remove the only record that
   * could. What it must stop holding is the material that identifies a person: the hashed
   * address, the user agent, and the link to a principal who may since have closed their
   * account (§23.5). The action, the target and the outcome stay.
   */
  pseudonymiseBefore(cutoff: string, limit: number): Promise<number>;
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

/**
 * SPEC §32.2 — where a resumable sweep over an external store got to.
 *
 * Cron invocations are separate processes with nothing between them, so a handler that pages
 * through a bucket has to write its position down or start over every time. Starting over is
 * not merely slow: a full first page of live objects hides everything behind it, for good.
 *
 * Absent means "start from the beginning", so a completed sweep deletes its row rather than
 * storing a null — one state, one representation.
 */
export interface RetentionCursorRepo {
  read(handler: string): Promise<string | null>;
  /** `null` finishes the sweep and drops the row. */
  write(handler: string, cursor: string | null, at: string): PendingWrite;
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
  /**
   * SPEC §23.4 — delivered rows, after seven days.
   *
   * Bounded per call rather than "everything older than": D1 has no statement timeout worth
   * relying on, and a first run against a table nobody has ever cleaned would be one
   * enormous DELETE inside a cron invocation with a wall clock. Repeated small passes drain
   * the same backlog and each one either finishes or is retried a minute later.
   */
  deleteSentBefore(cutoff: string, limit: number): Promise<number>;
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
