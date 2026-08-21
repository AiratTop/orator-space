import type { OratorId } from "@orator/protocol";
import { encodeId } from "@orator/protocol";
import {
  ConstraintViolation,
  type ArticleRecord,
  type ArticleRepo,
  type EventRepo,
  type IdempotencyRecord,
  type IdempotencyRepo,
  type NewEvent,
  type RevisionRecord,
  type AuditEntry,
  type AuditRepo,
  type Clock,
  type Database,
  type IdGen,
  type KeyRecord,
  type KeyRepo,
  type EventBus,
  type OutboxEntry,
  type OutboxRepo,
  type PendingWrite,
  type PrincipalRecord,
  type PrincipalRepo,
  type TokenRecord,
  type TokenRepo,
} from "../ports/index.js";
import type { Ports } from "../services/context.js";
import { createMemoryContentStore } from "./memory-content-store.js";

/**
 * In-memory implementations of every port, for domain tests (SPEC §68).
 *
 * They model the two behaviours the domain actually depends on: writes only take effect
 * when committed, and a commit is all-or-nothing. A double that applied writes eagerly
 * would let a service pass here and corrupt data against D1, which is the failure mode
 * test doubles are supposed to prevent rather than cause.
 */

/** Returns rows affected, mirroring what D1 reports back from a batch. */
type Apply = () => number | void;
const asWrite = (apply: Apply): PendingWrite => apply as unknown as PendingWrite;
const asApply = (write: PendingWrite): Apply => write as unknown as Apply;

export interface MemoryState {
  principals: Map<string, PrincipalRecord>;
  articles: Map<string, ArticleRecord>;
  revisions: Map<string, RevisionRecord>;
  events: NewEvent[];
  idempotency: Map<string, IdempotencyRecord>;
  humanEmails: Map<string, string | null>;
  tokens: Map<string, TokenRecord & { tokenHash: string }>;
  keys: Map<string, KeyRecord>;
  audit: AuditEntry[];
  outbox: OutboxEntry[];
}

/** Controls the doubles expose to tests, beyond the ports themselves. */
export interface MemoryControls {
  state: MemoryState;
  /** Moves the clock, for expiry, backoff and validity windows. */
  setNow(date: Date): void;
  /** Batches handed to the event bus, in order. */
  published: OutboxEntry[][];
  /** Makes the bus fail, to exercise the outbox recovery path. */
  failBus(error: Error | null): void;
}

export function createMemoryPorts(options: { now?: Date } = {}): Ports & MemoryControls {
  const state: MemoryState = {
    principals: new Map(),
    articles: new Map(),
    revisions: new Map(),
    events: [],
    idempotency: new Map(),
    humanEmails: new Map(),
    tokens: new Map(),
    keys: new Map(),
    audit: [],
    outbox: [],
  };

  let current = options.now ?? new Date("2026-08-21T12:00:00.000Z");
  const clock: Clock = { now: () => current };

  let counter = 0;
  const ids: IdGen = {
    next(): OratorId {
      const bytes = new Uint8Array(16);
      let ms = current.getTime();
      for (let i = 5; i >= 0; i--) {
        bytes[i] = ms & 0xff;
        ms = Math.floor(ms / 256);
      }
      counter += 1;
      bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
      bytes[7] = counter & 0xff;
      bytes[8] = 0x80;
      return encodeId(bytes);
    },
  };

  const database: Database = {
    async commit(writes) {
      // Snapshot, apply, roll back on the first violation — the all-or-nothing behaviour
      // D1's batch() gives us and the outbox pattern depends on (SPEC §35.2).
      const snapshot = {
        principals: new Map(state.principals),
        articles: new Map(state.articles),
        revisions: new Map(state.revisions),
        events: [...state.events],
        idempotency: new Map(state.idempotency),
        humanEmails: new Map(state.humanEmails),
        tokens: new Map(state.tokens),
        keys: new Map(state.keys),
        audit: [...state.audit],
        outbox: [...state.outbox],
      };
      try {
        const outcomes = [];
        for (const write of writes) outcomes.push({ changes: asApply(write)() ?? 1 });
        return outcomes;
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
  };

  const principals: PrincipalRepo = {
    async findById(id) {
      return state.principals.get(id) ?? null;
    },
    async findByUsername(username) {
      return [...state.principals.values()].find((p) => p.username === username) ?? null;
    },
    async findBySkeleton(skeleton) {
      return [...state.principals.values()].find((p) => p.usernameSkeleton === skeleton) ?? null;
    },
    async countAgentsOwnedBy(ownerPrincipalId) {
      return [...state.principals.values()].filter((p) => p.ownerPrincipalId === ownerPrincipalId).length;
    },
    insertPrincipal(principal) {
      return asWrite(() => {
        for (const existing of state.principals.values()) {
          if (existing.username === principal.username || existing.usernameSkeleton === principal.usernameSkeleton) {
            throw new ConstraintViolation("UNIQUE constraint failed: principals.username", "unique");
          }
        }
        state.principals.set(principal.id, {
          ...principal,
          bio: null,
          status: "active",
          platformRole: "user",
        });
      });
    },
    insertHumanAccount(principalId, email) {
      return asWrite(() => {
        state.humanEmails.set(principalId, email);
      });
    },
    insertAgent(agent) {
      return asWrite(() => {
        const principal = state.principals.get(agent.principalId);
        if (principal === undefined) {
          throw new ConstraintViolation("FOREIGN KEY constraint failed", "foreign-key");
        }
        if (!state.principals.has(agent.ownerPrincipalId)) {
          throw new ConstraintViolation("FOREIGN KEY constraint failed", "foreign-key");
        }
        state.principals.set(agent.principalId, {
          ...principal,
          ownerPrincipalId: agent.ownerPrincipalId,
          model: agent.model,
          provider: agent.provider,
          trustLevel: 0,
        });
      });
    },
  };

  const tokens: TokenRepo = {
    async findByHash(tokenHash) {
      return [...state.tokens.values()].find((t) => t.tokenHash === tokenHash) ?? null;
    },
    async listFor(principalId) {
      return [...state.tokens.values()].filter((t) => t.principalId === principalId);
    },
    insert(token) {
      return asWrite(() => {
        state.tokens.set(token.id, {
          id: token.id,
          principalId: token.principalId,
          name: token.name,
          scopes: [...token.scopes],
          prefix: token.prefix,
          expiresAt: token.expiresAt,
          revokedAt: null,
          createdAt: token.createdAt,
          lastUsedAt: null,
          tokenHash: token.tokenHash,
        });
      });
    },
    revoke(id, at) {
      return asWrite(() => {
        const token = state.tokens.get(id);
        if (token === undefined || token.revokedAt !== null) return 0;
        state.tokens.set(id, { ...token, revokedAt: at });
        return 1;
      });
    },
    touch(id, at) {
      return asWrite(() => {
        const token = state.tokens.get(id);
        if (token) state.tokens.set(id, { ...token, lastUsedAt: at });
      });
    },
  };

  const keys: KeyRepo = {
    async findById(id) {
      return state.keys.get(id) ?? null;
    },
    async findByFingerprint(print) {
      return [...state.keys.values()].find((k) => k.fingerprint === print) ?? null;
    },
    async listFor(agentPrincipalId) {
      return [...state.keys.values()].filter((k) => k.agentPrincipalId === agentPrincipalId);
    },
    insert(key) {
      return asWrite(() => {
        state.keys.set(key.id, { ...key, status: "active", revokedAt: null });
      });
    },
    revoke(id, at) {
      return asWrite(() => {
        const key = state.keys.get(id);
        if (key === undefined || key.status !== "active") return 0;
        state.keys.set(id, { ...key, status: "revoked", revokedAt: at });
        return 1;
      });
    },
  };

  const articles: ArticleRepo = {
    async findById(id) {
      const article = state.articles.get(id);
      if (article === undefined) return null;
      const author = state.principals.get(article.authorPrincipalId);
      return author?.ownerPrincipalId === undefined
        ? article
        : { ...article, authorOwnerPrincipalId: author.ownerPrincipalId };
    },
    async findRevision(id) {
      return state.revisions.get(id) ?? null;
    },
    async listRevisions(articleId, limit) {
      return [...state.revisions.values()]
        .filter((r) => r.articleId === articleId)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, limit);
    },
    async countRevisionsWithContent(contentHash) {
      return [...state.revisions.values()].filter((r) => r.contentHash === contentHash).length;
    },
    insertArticle(article) {
      return asWrite(() => {
        state.articles.set(article.id, {
          ...article,
          status: "draft",
          currentRevisionId: null,
          publishedRevisionId: null,
          translationGroupId: null,
          indexable: false,
          canonicalUrl: null,
          updatedAt: article.createdAt,
          publishedAt: null,
          removedAt: null,
        });
      });
    },
    insertRevision(revision) {
      return asWrite(() => {
        if (!state.articles.has(revision.articleId)) {
          throw new ConstraintViolation("FOREIGN KEY constraint failed", "foreign-key");
        }
        state.revisions.set(revision.id, { ...revision, signature: null, signatureKeyId: null });
      });
    },
    setCurrentRevision(articleId, revisionId, expectedRevisionId, updatedAt) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        // Mirrors the SQL: the update only applies when the pointer is what we expected.
        if (article === undefined || article.currentRevisionId !== expectedRevisionId) return 0;
        state.articles.set(articleId, { ...article, currentRevisionId: revisionId, updatedAt });
        return 1;
      });
    },
    publish(articleId, revisionId, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined || article.status === "removed") return 0;
        state.articles.set(articleId, {
          ...article,
          status: "published",
          publishedRevisionId: revisionId as ArticleRecord["publishedRevisionId"],
          publishedAt: article.publishedAt ?? at,
          updatedAt: at,
        });
        return 1;
      });
    },
    unpublish(articleId, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined || article.status !== "published") return 0;
        state.articles.set(articleId, { ...article, status: "unpublished", updatedAt: at });
        return 1;
      });
    },
    setStatus(articleId, status, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, { ...article, status, updatedAt: at });
        return 1;
      });
    },
    setSlug(articleId, slug, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, { ...article, slug, updatedAt: at });
        return 1;
      });
    },
    attachSignature(revisionId, signature, keyId) {
      return asWrite(() => {
        const revision = state.revisions.get(revisionId);
        if (revision === undefined || revision.signature !== null) return 0;
        state.revisions.set(revisionId, {
          ...revision,
          signature,
          signatureKeyId: keyId as RevisionRecord["signatureKeyId"],
        });
        return 1;
      });
    },
  };

  const events: EventRepo = {
    insert: (event) => asWrite(() => void state.events.push(event)),
    async listForAudience(principalId, since, limit) {
      return state.events
        .filter((e) => e.audiencePrincipalId === principalId && (since === null || e.id > since))
        .slice(0, limit);
    },
    async listForSubject(subjectType, subjectId, limit) {
      return state.events
        .filter((e) => e.subjectType === subjectType && e.subjectId === subjectId && e.visibility === "public")
        .slice(0, limit);
    },
  };

  const idempotency: IdempotencyRepo = {
    async find(principalId, key) {
      return state.idempotency.get(`${principalId}:${key}`) ?? null;
    },
    claim(record) {
      return asWrite(() => {
        const composite = `${record.principalId}:${record.key}`;
        if (state.idempotency.has(composite)) return 0;
        state.idempotency.set(composite, {
          ...record,
          status: "in_progress",
          responseStatus: null,
          responseJson: null,
        });
        return 1;
      });
    },
    complete(principalId, key, status, body) {
      return asWrite(() => {
        const composite = `${principalId}:${key}`;
        const record = state.idempotency.get(composite);
        if (record === undefined) return 0;
        state.idempotency.set(composite, {
          ...record,
          status: "completed",
          responseStatus: status,
          responseJson: body,
        });
        return 1;
      });
    },
    release(principalId, key) {
      return asWrite(() => (state.idempotency.delete(`${principalId}:${key}`) ? 1 : 0));
    },
  };

  const audit: AuditRepo = { record: (entry) => asWrite(() => void state.audit.push(entry)) };
  const sentOutbox = new Set<string>();
  const outboxMeta = new Map<string, { attempts: number; nextAttemptAt: string | null }>();

  const outbox: OutboxRepo = {
    enqueue: (entry) =>
      asWrite(() => {
        state.outbox.push(entry);
        outboxMeta.set(entry.id, { attempts: 0, nextAttemptAt: null });
      }),
    async listPending(now, limit) {
      return state.outbox
        .filter((entry) => {
          if (sentOutbox.has(entry.id)) return false;
          const meta = outboxMeta.get(entry.id);
          return meta === undefined || meta.nextAttemptAt === null || meta.nextAttemptAt <= now;
        })
        .slice(0, limit)
        .map((entry) => ({ ...entry, attempts: outboxMeta.get(entry.id)?.attempts ?? 0 }));
    },
    markSent: (ids) =>
      asWrite(() => {
        for (const id of ids) sentOutbox.add(id);
        return ids.length;
      }),
    markFailed: (id, _error, nextAttemptAt) =>
      asWrite(() => {
        const meta = outboxMeta.get(id) ?? { attempts: 0, nextAttemptAt: null };
        outboxMeta.set(id, { attempts: meta.attempts + 1, nextAttemptAt });
        return 1;
      }),
    async pendingStats() {
      const pending = state.outbox.filter((entry) => !sentOutbox.has(entry.id));
      return {
        count: pending.length,
        oldestCreatedAt: pending[0]?.createdAt ?? null,
      };
    },
  };

  /** Records what was handed to the bus, and can be told to fail (SPEC §35.2). */
  const published: OutboxEntry[][] = [];
  let busFailure: Error | null = null;
  const eventBus: EventBus = {
    async publish(entries) {
      if (busFailure !== null) throw busFailure;
      published.push([...entries]);
    },
  };

  return {
    db: database,
    principals,
    tokens,
    keys,
    audit,
    outbox,
    eventBus,
    articles,
    events,
    idempotency,
    content: createMemoryContentStore(),
    clock,
    ids,
    state,
    setNow: (date: Date) => {
      current = date;
    },
    published,
    failBus: (error: Error | null) => {
      busFailure = error;
    },
  };
}
