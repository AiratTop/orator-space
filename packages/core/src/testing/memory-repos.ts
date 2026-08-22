import type { FeedCursor, OratorId } from "@orator/protocol";
import { encodeId } from "@orator/protocol";
import type { ArticleLink } from "../ports/reading.js";
import { LIMITS, QUOTA_ACTIONS, verdict, windowStart } from "../identity/quota.js";
import type { QuotaGate } from "../ports/quota.js";
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
  type ArticleCard,
  type ArticleView,
  type AuthorSummary,
  type FeedPage,
  type ReadingRepo,
  type CommentRecord,
  type EdgeRecord,
  type SearchDocument,
  type SearchIndex,
  type SocialRepo,
  type ModerationRepo,
  type ModerationActionRecord,
  type ReportRecord,
  type TopicRecord,
  type TopicRepo,
  type TokenRecord,
  type TokenRepo,
  type MediaRecord,
  type MediaRepo,
  type MediaStore,
} from "../ports/index.js";
import { SNIFF_BYTES } from "../media/sniff.js";
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
  comments: Map<string, CommentRecord>;
  searchDocs: Map<string, SearchDocument>;
  topics: Map<string, TopicRecord>;
  reports: ReportRecord[];
  moderationActions: ModerationActionRecord[];
  media: Map<string, MediaRecord>;
  /** The bytes, keyed the same way the R2 adapter keys them. */
  mediaBytes: Map<string, Uint8Array>;
  articleTopics: Map<string, Set<string>>;
  edges: Map<string, EdgeRecord>;
  follows: Set<string>;
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
    comments: new Map(),
    searchDocs: new Map(),
    topics: new Map(),
    reports: [],
    moderationActions: [],
    media: new Map(),
    mediaBytes: new Map(),
    articleTopics: new Map(),
    edges: new Map(),
    follows: new Set(),
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
        comments: new Map(state.comments),
        searchDocs: new Map(state.searchDocs),
        topics: new Map(state.topics),
        reports: [...state.reports],
        moderationActions: [...state.moderationActions],
        media: new Map(state.media),
        mediaBytes: new Map(state.mediaBytes),
        articleTopics: new Map(state.articleTopics),
        edges: new Map(state.edges),
        follows: new Set(state.follows),
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
    setStatus(principalId, status, _at) {
      return asWrite(() => {
        const principal = state.principals.get(principalId);
        if (principal === undefined) return 0;
        state.principals.set(principalId, { ...principal, status });
        return 1;
      });
    },

    updateProfile(principalId, fields) {
      return asWrite(() => {
        const principal = state.principals.get(principalId);
        if (principal === undefined) return 0;
        state.principals.set(principalId, {
          ...principal,
          ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
          ...(fields.bio === undefined ? {} : { bio: fields.bio }),
        });
        return 1;
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
          authorUsername: state.principals.get(article.authorPrincipalId)?.username ?? "unknown",
          status: "draft",
          currentRevisionId: null,
          publishedRevisionId: null,
          translationGroupId: null,
          indexable: false,
          canonicalUrl: article.canonicalUrl,
          updatedAt: article.createdAt,
          publishedAt: null,
          removedAt: null,
          removalSource: null,
          moderationState: "unchecked",
          moderationVerdict: null,
          moderatedAt: null,
          simhash: null,
          indexableReason: null,
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
    publish(articleId, revisionId, at, publishedAt) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined || article.status === "removed") return 0;
        state.articles.set(articleId, {
          ...article,
          status: "published",
          publishedRevisionId: revisionId as ArticleRecord["publishedRevisionId"],
          // Filled once: the date an article carries is when it was first published, not
          // when it was last touched (§16.3).
          publishedAt: article.publishedAt ?? publishedAt,
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
    setStatus(articleId, status, at, removalSource) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, {
          ...article,
          status,
          updatedAt: at,
          // Together with the status, so a tombstone is never unable to say why (§23.2).
          ...(status === "removed"
            ? { removedAt: article.removedAt ?? at, removalSource: removalSource ?? "author" }
            : {}),
        });
        return 1;
      });
    },
    updateMetadata(articleId, fields, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, {
          ...article,
          ...(fields.visibility === undefined ? {} : { visibility: fields.visibility }),
          ...(fields.authorshipDisclosure === undefined
            ? {}
            : { authorshipDisclosure: fields.authorshipDisclosure }),
          ...(fields.canonicalUrl === undefined ? {} : { canonicalUrl: fields.canonicalUrl }),
          ...(fields.language === undefined ? {} : { language: fields.language }),
          ...(fields.indexable === undefined ? {} : { indexable: fields.indexable }),
          updatedAt: at,
        });
        return 1;
      });
    },
    eraseRevision(revisionId, at) {
      return asWrite(() => {
        const revision = state.revisions.get(revisionId);
        if (revision === undefined) return 0;
        // The hash stays: it is the trace §23.3 keeps, and it is not the content.
        state.revisions.set(revisionId, {
          ...revision,
          contentRef: "",
          title: "[erased]",
          excerpt: null,
          metadata: { schema_version: 1, erased_at: at },
        });
        return 1;
      });
    },
    setIndexability(articleId, fields, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, {
          ...article,
          indexable: fields.indexable,
          indexableReason: fields.reason,
          simhash: fields.simhash,
          updatedAt: at,
        });
        return 1;
      });
    },
    async findBySimhashBands(bands, excludeArticleId, limit) {
      const share = (hex: string) => {
        const value = BigInt(`0x${hex}`);
        return bands.some((band, i) => Number((value >> BigInt(i * 8)) & 0xffn) === band);
      };
      return [...state.articles.values()]
        .filter(
          (article) =>
            article.status === "published" &&
            article.visibility === "public" &&
            article.simhash !== null &&
            article.id !== excludeArticleId &&
            share(article.simhash),
        )
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((article) => ({ id: article.id, simhash: article.simhash! }));
    },
    setModerationState(articleId, verdictState, verdict, at) {
      return asWrite(() => {
        const article = state.articles.get(articleId);
        if (article === undefined) return 0;
        state.articles.set(articleId, {
          ...article,
          moderationState: verdictState,
          moderationVerdict: verdict,
          moderatedAt: at,
          updatedAt: at,
        });
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


  /**
   * The public read model (SPEC §49), assembled from the same maps the write path uses.
   *
   * Written as a projection rather than a second store on purpose: the value of this
   * double is that a service which publishes and then reads sees exactly what it wrote,
   * including the visibility rule. A separate fixture would let a test pass while the two
   * disagreed, which is the defect the double exists to catch.
   */
  const summarise = (principal: PrincipalRecord): AuthorSummary => ({
    id: principal.id,
    kind: principal.kind,
    username: principal.username,
    displayName: principal.displayName,
    bio: principal.bio,
    ownerUsername:
      principal.ownerPrincipalId === undefined
        ? null
        : (state.principals.get(principal.ownerPrincipalId)?.username ?? null),
    model: principal.model ?? null,
    trustLevel: principal.trustLevel ?? null,
  });

  const viewOf = (article: ArticleRecord): ArticleView | null => {
    if (article.status !== "published" || article.visibility !== "public") return null;
    if (article.publishedRevisionId === null) return null;
    const revision = state.revisions.get(article.publishedRevisionId);
    const author = state.principals.get(article.authorPrincipalId);
    if (revision === undefined || author === undefined || author.status !== "active") return null;
    const key = revision.signatureKeyId === null ? undefined : state.keys.get(revision.signatureKeyId);

    const comments = [...state.comments.values()].filter((c) => c.articleId === article.id);
    const edges = [...state.edges.values()].filter(
      (e) => e.srcArticleId === article.id || e.dstArticleId === article.id,
    );
    const changedAt = [...comments, ...edges]
      .map((row) => row.createdAt)
      .sort()
      .pop();

    return {
      article,
      revision,
      author: summarise(author),
      conversation: {
        token: `${comments.length}.${comments.filter((c) => c.status === "visible").length}:${edges.length}`,
        changedAt: changedAt ?? null,
      },
      signingKey:
        key === undefined
          ? null
          : { publicKey: key.publicKey, createdAt: key.createdAt, revokedAt: key.revokedAt },
    };
  };

  const cardOf = (view: ArticleView): ArticleCard => ({
    id: view.article.id,
    slug: view.article.slug,
    title: view.revision.title,
    excerpt: view.revision.excerpt,
    language: view.article.language,
    authorshipDisclosure: view.article.authorshipDisclosure,
    publishedAt: view.article.publishedAt ?? view.revision.createdAt,
    readingTimeSeconds: view.revision.readingTimeSeconds,
    contentHash: view.revision.contentHash,
    signed: view.revision.signature !== null,
    author: view.author,
  });

  const paginate = (views: ArticleView[], limit: number, before: FeedCursor | null): FeedPage => {
    const sorted = views
      .map(cardOf)
      .sort((a, b) =>
        a.publishedAt === b.publishedAt
          ? b.id.localeCompare(a.id)
          : b.publishedAt.localeCompare(a.publishedAt),
      );
    const after =
      before === null
        ? sorted
        : sorted.filter(
            (card) =>
              card.publishedAt < before.publishedAt ||
              (card.publishedAt === before.publishedAt && card.id < before.id),
          );
    const cards = after.slice(0, limit);
    const last = cards[cards.length - 1];
    return {
      cards,
      next: after.length > limit && last !== undefined ? { publishedAt: last.publishedAt, id: last.id } : null,
    };
  };

  /**
   * The quota counter, in memory (SPEC §59.1).
   *
   * Runs the same `verdict` the Durable Object runs, over the same fixed windows. A double
   * that approximated the rule would let the domain tests agree with something production
   * does not do, which is worse than having no double at all.
   */
  const counters = new Map<string, { window: number; count: number }>();
  const quota: QuotaGate = {
    async consume(principalId, action, trustLevel) {
      const now = clock.now();
      const start = windowStart(LIMITS[action].window, now);
      const key = `${principalId}:${action}`;
      const held = counters.get(key);
      const count = held !== undefined && held.window === start ? held.count + 1 : 1;
      counters.set(key, { window: start, count });
      return verdict(action, count, trustLevel, now);
    },
    async peek(principalId, trustLevel) {
      const now = clock.now();
      return QUOTA_ACTIONS.map((action) => {
        const held = counters.get(`${principalId}:${action}`);
        const start = windowStart(LIMITS[action].window, now);
        const used = held !== undefined && held.window === start ? held.count : 0;
        return verdict(action, used, trustLevel, now);
      });
    },
  };

  const reading: ReadingRepo = {
    async findPublished(id) {
      const article = state.articles.get(id);
      return article === undefined ? null : viewOf(article);
    },
    async listLatest(limit, before) {
      const views = [...state.articles.values()].map(viewOf).filter((v): v is ArticleView => v !== null);
      return paginate(views, limit, before);
    },
    async listByAuthor(principalId, limit, before) {
      const views = [...state.articles.values()]
        .filter((article) => article.authorPrincipalId === principalId)
        .map(viewOf)
        .filter((v): v is ArticleView => v !== null);
      return paginate(views, limit, before);
    },
    async loadConversation(articleId, limit) {
      const linkOf = (edge: EdgeRecord, farEnd: OratorId | null): ArticleLink => {
        const target = farEnd === null ? undefined : state.articles.get(farEnd);
        const view = target === undefined ? null : viewOf(target);
        return {
          id: edge.id,
          kind: edge.kind,
          note: edge.note,
          createdAt: edge.createdAt,
          article:
            view === null
              ? null
              : {
                  id: view.article.id,
                  slug: view.article.slug,
                  title: view.revision.title,
                  authorUsername: view.author.username,
                  authorKind: view.author.kind,
                },
          uri: edge.dstUri,
        };
      };

      const thread = [...state.comments.values()]
        .filter((comment) => comment.articleId === articleId)
        .sort((a, b) => a.id.localeCompare(b.id));
      const edges = [...state.edges.values()].sort((a, b) => a.id.localeCompare(b.id));

      return {
        comments: thread.slice(0, limit).flatMap((comment) => {
          const author = state.principals.get(comment.authorPrincipalId);
          if (author === undefined) return [];
          return {
            id: comment.id,
            parentCommentId: comment.parentCommentId,
            depth: comment.depth,
            stance: comment.stance,
            body: comment.status === "visible" ? comment.contentMarkdown : null,
            status: comment.status,
            createdAt: comment.createdAt,
            author: summarise(author),
          };
        }),
        inbound: edges
          .filter((edge) => edge.dstArticleId === articleId)
          .map((edge) => linkOf(edge, edge.srcArticleId)),
        outbound: edges
          .filter((edge) => edge.srcArticleId === articleId)
          .map((edge) => linkOf(edge, edge.dstArticleId)),
        truncated: thread.length > limit,
      };
    },

    async findPrincipalByUsername(username) {
      const principal = [...state.principals.values()].find(
        (candidate) => candidate.username === username && candidate.status === "active",
      );
      return principal === undefined ? null : summarise(principal);
    },
  };


  /**
   * Comments, edges and follows in memory (SPEC §17, §18, §19).
   *
   * The author fields are projected from `principals` on read rather than copied on write,
   * so a test that renames a principal does not leave a comment claiming the old name —
   * which is the same reason the D1 adapter joins instead of denormalising.
   */
  const withAuthor = (comment: CommentRecord): CommentRecord => {
    const author = state.principals.get(comment.authorPrincipalId);
    if (author === undefined) return comment;
    return {
      ...comment,
      authorUsername: author.username,
      authorKind: author.kind,
      ...(author.ownerPrincipalId === undefined ? {} : { authorOwnerPrincipalId: author.ownerPrincipalId }),
    };
  };

  const followKey = (follower: string, followee: string) => `${follower}\u0000${followee}`;

  const social: SocialRepo = {
    async findComment(id) {
      const comment = state.comments.get(id);
      return comment === undefined ? null : withAuthor(comment);
    },
    async listComments(articleId, limit, after) {
      return [...state.comments.values()]
        .filter((comment) => comment.articleId === articleId && (after === null || comment.id > after))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(withAuthor);
    },
    async countComments(articleId) {
      return [...state.comments.values()].filter(
        (comment) => comment.articleId === articleId && comment.status === "visible",
      ).length;
    },
    insertComment: (comment) =>
      asWrite(() => {
        state.comments.set(comment.id, {
          id: comment.id,
          articleId: comment.articleId,
          parentCommentId: comment.parentCommentId,
          rootCommentId: comment.rootCommentId,
          depth: comment.depth,
          authorPrincipalId: comment.authorPrincipalId,
          stance: comment.stance,
          contentMarkdown: comment.contentMarkdown,
          contentHash: comment.contentHash,
          status: "visible",
          createdAt: comment.createdAt,
          editedAt: null,
        });
        return 1;
      }),
    setCommentStatus: (id, status, at) =>
      asWrite(() => {
        const comment = state.comments.get(id);
        if (comment === undefined) return 0;
        state.comments.set(id, { ...comment, status, editedAt: at });
        return 1;
      }),

    async findEdge(id) {
      return state.edges.get(id) ?? null;
    },
    async listEdgesFor(articleId, limit, after) {
      return [...state.edges.values()]
        .filter(
          (edge) =>
            (edge.srcArticleId === articleId || edge.dstArticleId === articleId) &&
            (after === null || edge.id > after),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    insertEdge: (edge) =>
      asWrite(() => {
        // The unique index the schema puts on (src, kind, dst) — modelled, because the
        // service depends on the write failing rather than on checking first.
        const duplicate = [...state.edges.values()].some(
          (existing) =>
            existing.srcArticleId === edge.srcArticleId &&
            existing.kind === edge.kind &&
            existing.dstArticleId !== null &&
            existing.dstArticleId === edge.dstArticleId,
        );
        if (duplicate) throw new ConstraintViolation("UNIQUE constraint failed: edges", "unique");
        state.edges.set(edge.id, edge);
        return 1;
      }),
    deleteEdge: (id) => asWrite(() => (state.edges.delete(id) ? 1 : 0)),

    async isFollowing(followerId, followeeId) {
      return state.follows.has(followKey(followerId, followeeId));
    },
    insertFollow: (followerId, followeeId) =>
      asWrite(() => {
        state.follows.add(followKey(followerId, followeeId));
        return 1;
      }),
    deleteFollow: (followerId, followeeId) =>
      asWrite(() => (state.follows.delete(followKey(followerId, followeeId)) ? 1 : 0)),
    async countFollowers(principalId) {
      return [...state.follows].filter((key) => key.endsWith(`\u0000${principalId}`)).length;
    },
  };


  /**
   * The search index in memory (SPEC §38).
   *
   * Substring matching over the indexed fields — not BM25, and not trying to be. What the
   * domain tests need to know is that the right documents enter and leave the index at the
   * right moments; how well FTS5 ranks them is FTS5's business, and testing it here would
   * only assert that this double behaves like this double.
   */
  const search: SearchIndex = {
    async index(document, _at) {
      state.searchDocs.set(document.articleId, document);
    },
    async remove(articleId) {
      state.searchDocs.delete(articleId);
    },
    async indexedHash(articleId) {
      return state.searchDocs.get(articleId)?.contentHash ?? null;
    },
    async query(text, limit) {
      const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
      return [...state.searchDocs.values()]
        .filter((doc) => {
          const haystack = `${doc.title} ${doc.excerpt} ${doc.body} ${doc.author} ${doc.topics}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .slice(0, limit)
        .map((doc) => doc.articleId);
    },
  };


  /** SPEC §22 — curated, and empty until a moderator puts something in it. */
  const topics: TopicRepo = {
    async list() {
      return [...state.topics.values()].sort((a, b) => a.label.localeCompare(b.label));
    },
    async findBySlug(slug) {
      return [...state.topics.values()].find((topic) => topic.slug === slug) ?? null;
    },
    async listArticles(topicId, limit, after) {
      const ids = state.articleTopics.get(topicId) ?? new Set<string>();
      const views = [...ids]
        .filter((id) => after === null || id > after)
        .sort()
        .slice(0, limit)
        .map((id) => state.articles.get(id))
        .filter((article) => article !== undefined)
        .map((article) => viewOf(article))
        .filter((view): view is ArticleView => view !== null);
      return views.map(cardOf);
    },
  };


  const media: MediaRepo = {
    async findById(id) {
      return state.media.get(id) ?? null;
    },
    insert: (record) =>
      asWrite(() => {
        state.media.set(record.id, {
          ...record,
          status: "pending",
          storageKey: null,
          contentType: null,
          byteSize: null,
          checksumSha256: null,
          finalizedAt: null,
        });
        return 1;
      }),
    markReady: (id, stored) =>
      asWrite(() => {
        const record = state.media.get(id);
        // Conditional on `pending`, exactly as the SQL is: a double is only useful if it
        // refuses what the real thing refuses (SPEC §34.3).
        if (record === undefined || record.status !== "pending") return 0;
        state.media.set(id, { ...record, status: "ready", ...stored });
        return 1;
      }),
    markRejected: (id, at) =>
      asWrite(() => {
        const record = state.media.get(id);
        if (record === undefined || record.status !== "pending") return 0;
        state.media.set(id, { ...record, status: "rejected", finalizedAt: at });
        return 1;
      }),
  };

  /**
   * The media store, in memory.
   *
   * It buffers, where the real one streams — the difference the adapter exists to hide.
   * What it does reproduce is the part the domain depends on: a body that does not match
   * its declared length is refused rather than stored, because that is the contract the
   * service handles a failure from.
   */
  const mediaStore: MediaStore = {
    async put(key, body, declaredLength) {
      const chunks: Uint8Array[] = [];
      let byteSize = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        byteSize += value.byteLength;
      }
      if (byteSize !== declaredLength) {
        throw new Error(`declared ${declaredLength} bytes, received ${byteSize}`);
      }
      const bytes = new Uint8Array(byteSize);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      state.mediaBytes.set(key, bytes);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        byteSize,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        leading: bytes.subarray(0, SNIFF_BYTES),
      };
    },
    async get(key) {
      const bytes = state.mediaBytes.get(key);
      if (bytes === undefined) return null;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        byteSize: bytes.byteLength,
        etag: `"${bytes.byteLength}"`,
      };
    },
    async delete(key) {
      state.mediaBytes.delete(key);
    },
  };

  const moderation: ModerationRepo = {
    insertReport: (report) =>
      asWrite(() =>
        void state.reports.push({
          ...report,
          status: "open",
          resolution: null,
          reviewedBy: null,
          reviewedAt: null,
        }),
      ),
    async countRecentReports(targetType, targetId, since) {
      return state.reports.filter(
        (report) =>
          report.targetType === targetType && report.targetId === targetId && report.createdAt >= since,
      ).length;
    },

    async listReports(status, limit, after) {
      return state.reports
        .filter((report) => (status === null || report.status === status) && (after === null || report.id > after))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async findReport(id) {
      return state.reports.find((report) => report.id === id) ?? null;
    },
    setReportStatus(id, status, expected, reviewedBy, resolution, at) {
      return asWrite(() => {
        const report = state.reports.find((entry) => entry.id === id);
        // The guard is the whole point: two moderators working one queue is ordinary, and
        // the second write must be a no-op the service can notice (§34.3).
        if (report === undefined || !expected.includes(report.status)) return 0;
        Object.assign(report, { status, reviewedBy, resolution, reviewedAt: at });
        return 1;
      });
    },

    insertAction: (action) => asWrite(() => void state.moderationActions.push({ ...action, reversedAt: null })),
    async listActions(targetType, targetId, limit) {
      return state.moderationActions
        .filter((action) => action.targetType === targetType && action.targetId === targetId)
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, limit);
    },
    reverseAction(id, at) {
      return asWrite(() => {
        const action = state.moderationActions.find((entry) => entry.id === id && entry.reversedAt === null);
        if (action === undefined) return 0;
        action.reversedAt = at;
        return 1;
      });
    },
    async findLastAction(targetType, targetId) {
      return (
        state.moderationActions
          .filter(
            (action) =>
              action.targetType === targetType && action.targetId === targetId && action.reversedAt === null,
          )
          .sort((a, b) => b.id.localeCompare(a.id))[0] ?? null
      );
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
    reading,
    quota,
    social,
    search,
    topics,
    media,
    mediaStore,
    moderation,
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
