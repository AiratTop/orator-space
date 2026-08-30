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
  type TelegramAccount,
  type TelegramLink,
  type TelegramLogin,
  type TelegramRepo,
  type PrincipalRepo,
  type ArticleCard,
  type LinkedArticle,
  type ArticleView,
  type AuthorSummary,
  type FeedPage,
  type FeedWindow,
  type ReadingRepo,
  type CommentRecord,
  type EdgeRecord,
  type SearchDocument,
  type EmbeddingLedger,
  type EmbeddingRecord,
  type SearchIndex,
  type SocialRepo,
  type ModerationRepo,
  type CredentialRecord,
  type MetricEvent,
  type CredentialRepo,
  type ModerationActionRecord,
  type SessionRecord,
  type SessionRepo,
  type ReportQuery,
  type ReportRecord,
  type TopicRecord,
  type ReadingListRepo,
  type TopicAssignmentRepo,
  type TopicRepo,
  type TokenRecord,
  type TokenRepo,
  type MediaRecord,
  type MediaRepo,
  type MediaStore,
  type SitemapRepo,
  type SloRepo,
  type AssetStore,
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
  metrics: MetricEvent[];
  credentials: CredentialRecord[];
  sessions: (SessionRecord & { tokenHash: string; userAgent: string | null })[];
  reports: ReportRecord[];
  moderationActions: ModerationActionRecord[];
  telegramAccounts: Map<string, TelegramAccount>;
  telegramLinks: Map<string, TelegramLink>;
  telegramDeliveries: Map<string, string>;
  telegramLogins: Map<string, TelegramLogin>;
  media: Map<string, MediaRecord>;
  /** The bytes, keyed the same way the R2 adapter keys them. */
  mediaBytes: Map<string, Uint8Array>;
  articleTopics: Map<string, Set<string>>;
  readingList: Map<string, Set<string>>;
  classifications: Map<string, { contentHash: string; provider: string; topicCount: number }>;
  /** `${articleId}:${topicId}` → source, so a correction can outrank the machine (§22). */
  topicSources: Map<string, string>;
  /** SPEC §51 — the dirty flags, and the built files keyed as R2 keys them. */
  sitemapShards: Map<string, { dirty: boolean; urlCount: number; builtAt: string | null }>;
  assets: Map<string, string>;
  edges: Map<string, EdgeRecord>;
  follows: Set<string>;
  /** SPEC §66.4 — when each article was indexed, which is half of the lag measurement. */
  searchIndexedAt: Map<string, string>;
  /** SPEC §38.2 — what has been embedded, and from which text. */
  embeddings: Map<string, EmbeddingRecord>;
  /** SPEC §66.4 — arrival times of messages the consumer gave up on. */
  deadLetters: string[];
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
    metrics: [],
    credentials: [],
    sessions: [],
    reports: [],
    moderationActions: [],
    telegramAccounts: new Map(),
    telegramLinks: new Map(),
    telegramDeliveries: new Map(),
    telegramLogins: new Map(),
    sitemapShards: new Map(),
    assets: new Map(),
    media: new Map(),
    mediaBytes: new Map(),
    articleTopics: new Map(),
    readingList: new Map(),
    classifications: new Map(),
    topicSources: new Map(),
    edges: new Map(),
    follows: new Set(),
    searchIndexedAt: new Map(),
    embeddings: new Map(),
    deadLetters: [],
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
        embeddings: new Map(state.embeddings),
        topics: new Map(state.topics),
        metrics: [...state.metrics],
        credentials: [...state.credentials],
        sessions: [...state.sessions],
        reports: [...state.reports],
        moderationActions: [...state.moderationActions],
        telegramAccounts: new Map(state.telegramAccounts),
        telegramLinks: new Map(state.telegramLinks),
        telegramDeliveries: new Map(state.telegramDeliveries),
        telegramLogins: new Map(state.telegramLogins),
        media: new Map(state.media),
        mediaBytes: new Map(state.mediaBytes),
        articleTopics: new Map(state.articleTopics),
        readingList: new Map(state.readingList),
        classifications: new Map(state.classifications),
        topicSources: new Map(state.topicSources),
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
    async listAgentsOwnedBy(ownerPrincipalId) {
      return [...state.principals.values()].filter(
        (principal) => principal.ownerPrincipalId === ownerPrincipalId,
      );
    },
    blankHumanAccount(principalId, _at) {
      return asWrite(() => {
        state.humanEmails.set(principalId, null);
        return 1;
      });
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
          systemAccount: false,
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
        const updated: PrincipalRecord = {
          ...principal,
          ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
          ...(fields.bio === undefined ? {} : { bio: fields.bio }),
          // Silently absent until now, so every test that set an avatar through this double
          // was asserting against a field the double never wrote (§68: a double that agrees
          // with whatever it is told proves nothing).
          ...(fields.avatarMediaId === undefined
            ? {}
            : { avatarMediaId: (fields.avatarMediaId ?? null) as OratorId | null }),
        };
        state.principals.set(principalId, updated);
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
    revokeAllFor(principalId, at) {
      return asWrite(() => {
        let n = 0;
        for (const [id, token] of state.tokens) {
          if (token.principalId === principalId && token.revokedAt === null) {
            state.tokens.set(id, { ...token, revokedAt: at });
            n += 1;
          }
        }
        return n;
      });
    },
    async findByHash(tokenHash) {
      return [...state.tokens.values()].find((t) => t.tokenHash === tokenHash) ?? null;
    },
    async findById(id) {
      return state.tokens.get(id) ?? null;
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
    async listRevisions(articleId, { limit, cursor = null, publishedOnly = false }) {
      return [...state.revisions.values()]
        .filter((r) => r.articleId === articleId)
        .filter((r) => cursor === null || r.id < cursor)
        .filter((r) => !publishedOnly || (r.publishedAt !== null && r.publishedAt !== undefined))
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
    markRevisionPublished(revisionId, at) {
      return asWrite(() => {
        const revision = state.revisions.get(revisionId);
        if (revision === undefined) return 0;
        // Filled once, like the article's own date: republishing after an unpublish does not
        // restamp when the text first became public.
        revision.publishedAt = revision.publishedAt ?? at;
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
          ...(fields.featuredMediaId === undefined
            ? {}
            : { featuredMediaId: fields.featuredMediaId as OratorId | null }),
          ...(fields.indexable === undefined ? {} : { indexable: fields.indexable }),
          updatedAt: at,
        });
        return 1;
      });
    },
    eraseRevisionsOf(articleId, at) {
      return asWrite(() => {
        let n = 0;
        for (const [id, revision] of state.revisions) {
          if (revision.articleId !== articleId) continue;
          // The hash stays: it is the trace §23.3 keeps, and it is not the content.
          state.revisions.set(id, {
            ...revision,
            contentRef: "",
            title: "[erased]",
            excerpt: null,
            metadata: { schema_version: 1, erased_at: at },
          });
          n += 1;
        }
        return n;
      });
    },
    async listUnreferencedContent(limit) {
      const live = new Map<string, number>();
      for (const revision of state.revisions.values()) {
        const current = live.get(revision.contentHash) ?? 0;
        live.set(revision.contentHash, current + (revision.contentRef === "" ? 0 : 1));
      }
      return [...live].filter(([, n]) => n === 0).map(([hash]) => hash).slice(0, limit);
    },

    async contentReferences(articleId) {
      const hashes = new Set(
        [...state.revisions.values()].filter((r) => r.articleId === articleId).map((r) => r.contentHash),
      );
      return [...hashes].map((contentHash) => {
        const sharing = [...state.revisions.values()].filter((r) => r.contentHash === contentHash);
        return {
          contentHash,
          mine: sharing.filter((r) => r.articleId === articleId).length,
          // Live references only: a blanked revision points at nothing.
          elsewhere: sharing.filter((r) => r.articleId !== articleId && r.contentRef !== "").length,
        };
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
          duplicateOf: fields.duplicateOf as OratorId | null,
          simhash: fields.simhash,
          updatedAt: at,
        });
        return 1;
      });
    },
    async findByContentHash(contentHash, excludingArticleId) {
      const match = [...state.articles.values()]
        .filter(
          (a) =>
            a.id < excludingArticleId &&
            a.status === "published" &&
            a.visibility === "public" &&
            a.publishedRevisionId !== null &&
            state.revisions.get(a.publishedRevisionId)?.contentHash === contentHash,
        )
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      return match === undefined ? null : { id: match.id };
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
    async listSystemArticlesBefore(cutoff, limit) {
      return [...state.articles.values()]
        .filter((article) => {
          const author = state.principals.get(article.authorPrincipalId);
          return author?.systemAccount === true && article.createdAt < cutoff;
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((article) => article.id);
    },
    deleteArticles(ids) {
      return [
        asWrite(() => {
          for (const [id, revision] of state.revisions) {
            if (ids.includes(revision.articleId)) state.revisions.delete(id);
          }
          return ids.length;
        }),
        asWrite(() => {
          for (const id of ids) state.articles.delete(id);
          return ids.length;
        }),
      ];
    },
    async listByAuthor(authorPrincipalId, limit) {
      return [...state.articles.values()]
        .filter((article) => article.authorPrincipalId === authorPrincipalId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit);
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
    async deleteBefore(cutoff, limit) {
      const stale = [...state.idempotency.entries()]
        .filter(([, record]) => record.createdAt < cutoff)
        .slice(0, limit);
      for (const [key] of stale) state.idempotency.delete(key);
      return stale.length;
    },
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

  const audit: AuditRepo = {
    async pseudonymiseBefore(cutoff, limit) {
      const stale = state.audit
        .filter(
          (entry) =>
            entry.createdAt < cutoff &&
            (entry.ipHash !== null || entry.userAgent !== null || entry.actorPrincipalId !== null),
        )
        .slice(0, limit);
      for (const entry of stale) {
        entry.ipHash = null;
        entry.userAgent = null;
        entry.actorPrincipalId = null;
      }
      return stale.length;
    }, record: (entry) => asWrite(() => void state.audit.push(entry)) };
  const sentOutbox = new Set<string>();
  const outboxMeta = new Map<string, { attempts: number; nextAttemptAt: string | null }>();

  const outbox: OutboxRepo = {
    async deleteSentBefore(cutoff, limit) {
      // `sentOutbox` is where this double records delivery; the D1 adapter uses a status
      // column. Either way, only a row that was delivered is eligible (§23.4).
      const stale = state.outbox
        .filter((entry) => sentOutbox.has(entry.id) && entry.createdAt < cutoff)
        .slice(0, limit);
      for (const entry of stale) state.outbox.splice(state.outbox.indexOf(entry), 1);
      return stale.length;
    },
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
    systemAccount: principal.systemAccount,
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
      signals: {
        comments: comments.filter((c) => c.status === "visible").length,
        inbound: edges.filter((e) => e.dstArticleId === article.id).length,
      },
      signingKey:
        key === undefined
          ? null
          : { publicKey: key.publicKey, createdAt: key.createdAt, revokedAt: key.revokedAt },
    };
  };

  const cardOf = (view: ArticleView): ArticleCard => ({
    id: view.article.id,
    title: view.revision.title,
    excerpt: view.revision.excerpt,
    language: view.article.language,
    authorshipDisclosure: view.article.authorshipDisclosure,
    publishedAt: view.article.publishedAt ?? view.revision.createdAt,
    readingTimeSeconds: view.revision.readingTimeSeconds,
    contentHash: view.revision.contentHash,
    signed: view.revision.signature !== null,
    author: view.author,
    conversation: view.signals,
  });

  const cursorOf = (card: ArticleCard): FeedCursor => ({ publishedAt: card.publishedAt, id: card.id });
  const isOlder = (card: ArticleCard, than: FeedCursor) =>
    card.publishedAt < than.publishedAt || (card.publishedAt === than.publishedAt && card.id < than.id);

  const paginate = (views: ArticleView[], limit: number, window: FeedWindow): FeedPage => {
    const sorted = views
      .map(cardOf)
      .sort((a, b) =>
        a.publishedAt === b.publishedAt
          ? b.id.localeCompare(a.id)
          : b.publishedAt.localeCompare(a.publishedAt),
      );

    if (window.after !== null && window.before === null) {
      // Newest-first still, but the window is taken from the other end of what is newer.
      const newer = sorted.filter((card) => !isOlder(card, window.after!) && card.id !== window.after!.id);
      const cards = newer.slice(Math.max(0, newer.length - limit));
      const first = cards[0];
      const last = cards[cards.length - 1];
      return {
        cards,
        next: last === undefined ? null : cursorOf(last),
        previous: newer.length > limit && first !== undefined ? cursorOf(first) : null,
      };
    }

    const before = window.before;
    const older = before === null ? sorted : sorted.filter((card) => isOlder(card, before));
    const cards = older.slice(0, limit);
    const first = cards[0];
    const last = cards[cards.length - 1];
    return {
      cards,
      next: older.length > limit && last !== undefined ? cursorOf(last) : null,
      previous: before !== null && first !== undefined ? cursorOf(first) : null,
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
    async listLatest(limit, window) {
      const views = [...state.articles.values()].map(viewOf).filter((v): v is ArticleView => v !== null);
      return paginate(views, limit, window);
    },
    async listByAuthor(principalId, limit, window) {
      const views = [...state.articles.values()]
        .filter((article) => article.authorPrincipalId === principalId)
        .map(viewOf)
        .filter((v): v is ArticleView => v !== null);
      return paginate(views, limit, window);
    },
    async countPublished() {
      return [...state.articles.values()].map(viewOf).filter((v) => v !== null).length;
    },

    /** SPEC §7.2 — the other half of `ownerUsername`. */
    async topicsOf(articleId) {
      return [...state.topics.values()]
        .filter((topic) => state.articleTopics.get(topic.id)?.has(articleId) === true)
        .map((topic) => ({
          slug: topic.slug,
          label: topic.label,
          source: (state.topicSources.get(`${articleId}:${topic.id}`) ?? "ai") as
            | "author"
            | "ai"
            | "moderator",
        }));
    },

    async listRelated(articleId, limit) {
      const mine = [...state.topics.values()].filter(
        (topic) => state.articleTopics.get(topic.id)?.has(articleId) === true,
      );
      const shared = new Map<string, number>();
      for (const topic of mine) {
        for (const id of state.articleTopics.get(topic.id) ?? []) {
          if (id !== articleId) shared.set(id, (shared.get(id) ?? 0) + 1);
        }
      }
      return [...shared.entries()]
        .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
        .slice(0, limit)
        .map(([id]) => state.articles.get(id))
        .filter((article) => article !== undefined)
        .map((article) => viewOf(article))
        .filter((view): view is ArticleView => view !== null)
        .map(cardOf);
    },

    async topicsForArticles(articleIds) {
      const grouped = new Map<string, { slug: string; label: string; source: "author" | "ai" | "moderator" }[]>();
      for (const articleId of articleIds) {
        const list = [...state.topics.values()]
          .filter((topic) => state.articleTopics.get(topic.id)?.has(articleId) === true)
          .map((topic) => ({
            slug: topic.slug,
            label: topic.label,
            source: (state.topicSources.get(`${articleId}:${topic.id}`) ?? "ai") as
              | "author"
              | "ai"
              | "moderator",
          }));
        if (list.length > 0) grouped.set(articleId, list);
      }
      return grouped;
    },

    async listAgentsOf(ownerPrincipalId, limit) {
      const owned = [...state.principals.values()]
        .filter(
          (candidate) =>
            candidate.kind === "agent" &&
            candidate.ownerPrincipalId === ownerPrincipalId &&
            candidate.status === "active" &&
            !candidate.systemAccount,
        )
        .map((agent) => ({
          id: agent.id,
          username: agent.username,
          displayName: agent.displayName,
          model: agent.model ?? null,
          articles: [...state.articles.values()].filter(
            (article) => article.authorPrincipalId === agent.id && viewOf(article) !== null,
          ).length,
        }))
        .sort((a, b) => b.articles - a.articles || a.username.localeCompare(b.username));

      return { agents: owned.slice(0, limit), total: owned.length };
    },

    /*
     * The profile tabs (§49.2). Written the long way rather than with a shared helper: the
     * point of this double is to be obviously correct next to SQL that is merely correct.
     */
    async listCommentsByAuthor(principalId, limit, before) {
      const rows = [...state.comments.values()]
        .filter((c) => c.authorPrincipalId === principalId)
        .filter((c) => {
          const article = state.articles.get(c.articleId);
          return article !== undefined && viewOf(article) !== null;
        })
        .filter((c) => before === null || c.id < before)
        .sort((a, b) => b.id.localeCompare(a.id));

      const page = rows.slice(0, limit);
      return {
        comments: page.map((c) => {
          const view = viewOf(state.articles.get(c.articleId)!)!;
          return {
            id: c.id,
            stance: c.stance,
            body: c.status === "visible" ? c.contentMarkdown : null,
            status: c.status,
            createdAt: c.createdAt,
            article: {
              id: view.article.id,
              title: view.revision.title,
              authorUsername: view.author.username,
            },
          };
        }),
        next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },

    async listCitationsOf(principalId, limit, before) {
      const linked = (view: ArticleView): LinkedArticle => ({
        id: view.article.id,
        title: view.revision.title,
        authorUsername: view.author.username,
        authorKind: view.author.kind,
      });

      const rows = [...state.edges.values()]
        .filter((e) => before === null || e.id < before)
        .map((edge) => {
          const target = edge.dstArticleId === null ? undefined : state.articles.get(edge.dstArticleId);
          const source = state.articles.get(edge.srcArticleId);
          const targetView = target === undefined ? null : viewOf(target);
          const sourceView = source === undefined ? null : viewOf(source);
          if (targetView === null || sourceView === null) return null;
          if (targetView.article.authorPrincipalId !== principalId) return null;
          // §84 — what other people said, which is why a self-citation is not one.
          if (sourceView.article.authorPrincipalId === principalId) return null;
          return {
            id: edge.id,
            kind: edge.kind,
            note: edge.note,
            createdAt: edge.createdAt,
            source: linked(sourceView),
            target: linked(targetView),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((a, b) => b.id.localeCompare(a.id));

      const page = rows.slice(0, limit);
      return { citations: page, next: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
    },

    async countProfile(principalId) {
      const all = Number.MAX_SAFE_INTEGER;
      const [comments, citations] = await Promise.all([
        reading.listCommentsByAuthor(principalId, all, null),
        reading.listCitationsOf(principalId, all, null),
      ]);
      return {
        articles: [...state.articles.values()].filter(
          (a) => a.authorPrincipalId === principalId && viewOf(a) !== null,
        ).length,
        comments: comments.comments.length,
        citations: citations.citations.length,
      };
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

    async listPublishedRevisions(articleId, limit) {
      return [...state.revisions.values()]
        .filter((revision) => revision.articleId === articleId &&
            revision.publishedAt !== null &&
            revision.publishedAt !== undefined)
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
        .slice(0, limit)
        .map((revision) => {
          const author = state.principals.get(revision.createdByPrincipalId);
          return {
            id: revision.id,
            title: revision.title,
            excerpt: revision.excerpt,
            contentHash: revision.contentHash,
            contentBytes: revision.contentBytes,
            createdBy:
              author === undefined
                ? null
                : {
                    id: author.id,
                    kind: author.kind,
                    username: author.username,
                    displayName: author.displayName,
                    bio: author.bio,
                    ownerUsername: null,
                    model: author.model ?? null,
                    trustLevel: author.trustLevel ?? null,
                    systemAccount: author.systemAccount,
                  },
            signed: revision.signature !== null,
            createdAt: revision.createdAt,
            publishedAt: revision.publishedAt!,
          };
        });
    },

    async findPrincipalByUsername(username) {
      // §66.7 — a profile is on the list of things a canary does not appear in.
      const principal = [...state.principals.values()].find(
        (candidate) =>
          candidate.username === username &&
          candidate.status === "active" &&
          !candidate.systemAccount,
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
    async index(document, at) {
      state.searchDocs.set(document.articleId, document);
      state.searchIndexedAt.set(document.articleId, at);
    },
    async remove(articleId) {
      state.searchDocs.delete(articleId);
      state.searchIndexedAt.delete(articleId);
    },
    async indexedHash(articleId) {
      // The input hash, like the D1 adapter: what the entry was built from, not the body it
      // describes. A double that answered with the body would make the title-only edit ADR
      // 0012 fixed pass here and fail in production, which is the worst kind of double.
      return state.searchDocs.get(articleId)?.inputHash ?? null;
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


  /**
   * The embedding ledger in memory (SPEC §38.2).
   *
   * Only the ledger has a double. `Embedder` and `VectorIndex` are handed to the two services
   * that use them, so a test constructs whichever fake it needs for the behaviour it is
   * asserting — a model that throws, a store that is empty — rather than reaching for one
   * blessed double that has to be all of them.
   */
  const embeddings: EmbeddingLedger = {
    async find(articleId) {
      return state.embeddings.get(articleId) ?? null;
    },
    record: (entry) =>
      asWrite(() => {
        state.embeddings.set(entry.articleId, {
          inputHash: entry.inputHash,
          revisionId: entry.revisionId,
          model: entry.model,
          dimensions: entry.dimensions,
        });
        return 1;
      }),
    forget: (articleId) => asWrite(() => (state.embeddings.delete(articleId) ? 1 : 0)),
    async listStale(model, limit) {
      return staleIds(model).slice(0, limit);
    },
    async countStale(model, cap) {
      return Math.min(staleIds(model).length, cap);
    },
  };

  /** The same predicate the D1 ledger expresses in SQL, so the two agree about "stale". */
  function staleIds(model: string): OratorId[] {
    return [...state.articles.values()]
      .filter((article) => {
        if (article.status !== "published" || article.visibility !== "public") return false;
        if (article.duplicateOf !== null && article.duplicateOf !== undefined) return false;
        if (article.publishedRevisionId === null) return false;
        const held = state.embeddings.get(article.id);
        // Never embedded, by another model, or from a revision that is no longer published —
        // the third is what migration 0023 added, and a double that omitted it would let the
        // gap this fixes pass here and stay open in production.
        return (
          held === undefined ||
          held.model !== model ||
          held.revisionId !== article.publishedRevisionId
        );
      })
      .map((article) => article.id)
      .sort();
  }

  /** SPEC §22 — curated, and empty until a moderator puts something in it. */
  const topics: TopicRepo = {
    async list() {
      // Active only, like the D1 repo — whose `WHERE status = 'active'` is what makes §22.1's
      // "an archived topic keeps its page and leaves the vocabulary" true. A double that
      // returned archived rows made the difference untestable and the service's own filter
      // look redundant.
      return [...state.topics.values()]
        .filter((topic) => topic.status === "active")
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    async findBySlug(slug) {
      return [...state.topics.values()].find((topic) => topic.slug === slug) ?? null;
    },
    async tree() {
      const all = [...state.topics.values()];
      const count = (topic: TopicRecord) =>
        new Set(
          [topic, ...all.filter((child) => child.parentSlug === topic.slug)].flatMap((t) => [
            ...(state.articleTopics.get(t.id) ?? []),
          ]),
        ).size;
      return all
        .filter((topic) => topic.parentSlug === null && topic.status === "active")
        .map((section) => ({
          section,
          articles: count(section),
          children: all
            .filter((topic) => topic.parentSlug === section.slug && topic.status === "active")
            .map((topic) => ({ topic, articles: count(topic) })),
        }));
    },
    async listArticles(topicId, limit, before) {
      const section = [...state.topics.values()].find((topic) => topic.id === topicId);
      const own = [...state.topics.values()]
        .filter((topic) => section !== undefined && topic.parentSlug === section.slug)
        .map((topic) => topic.id);
      const ids = new Set([topicId, ...own].flatMap((id) => [...(state.articleTopics.get(id) ?? [])]));
      const views = [...ids]
        .filter((id) => before === null || id < before)
        .sort()
        .reverse()
        .slice(0, limit)
        .map((id) => state.articles.get(id))
        .filter((article) => article !== undefined)
        .map((article) => viewOf(article))
        .filter((view): view is ArticleView => view !== null);
      return views.map(cardOf);
    },
    async indexableCounts() {
      const counts = new Map<string, number>();
      for (const topic of state.topics.values()) {
        const ids = [...(state.articleTopics.get(topic.id) ?? [])];
        const n = ids.filter((id) => state.articles.get(id)?.indexable === true).length;
        if (n > 0) counts.set(topic.slug, n);
      }
      return counts;
    },
  };


  /** SPEC §22.3 — the classifier's half of the taxonomy, in memory. */
  const topicAssignments: TopicAssignmentRepo = {
    replaceAiTopics(articleId, topics) {
      return [
        asWrite(() => {
          for (const [topicId, ids] of state.articleTopics) {
            if (state.topicSources.get(`${articleId}:${topicId}`) === "ai") {
              ids.delete(articleId);
              state.topicSources.delete(`${articleId}:${topicId}`);
            }
          }
          for (const topic of topics) {
            const existing = state.topicSources.get(`${articleId}:${topic.topicId}`);
            // An author's or a moderator's row outranks the machine being corrected (§22).
            if (existing !== undefined && existing !== "ai") continue;
            const ids = state.articleTopics.get(topic.topicId) ?? new Set<string>();
            ids.add(articleId);
            state.articleTopics.set(topic.topicId, ids);
            state.topicSources.set(`${articleId}:${topic.topicId}`, "ai");
          }
          return topics.length;
        }),
      ];
    },
    async findClassification(articleId) {
      const record = state.classifications.get(articleId);
      return record === undefined ? null : { contentHash: record.contentHash, provider: record.provider };
    },
    recordClassification(record) {
      return asWrite(() => {
        state.classifications.set(record.articleId, {
          contentHash: record.contentHash,
          provider: record.provider,
          topicCount: record.topicCount,
        });
        return 1;
      });
    },
    async idsForSlugs(slugs) {
      const wanted = new Set(slugs);
      return new Map(
        [...state.topics.values()]
          .filter((topic) => wanted.has(topic.slug) && topic.status === "active")
          .map((topic) => [topic.slug, topic.id as string]),
      );
    },
  };

  /** ADR 0011 — a private list, and nothing here can produce a public number. */
  const readingList: ReadingListRepo = {
    async has(principalId, articleId) {
      return state.readingList.get(principalId)?.has(articleId) === true;
    },
    async list(principalId, limit, before) {
      return [...(state.readingList.get(principalId) ?? [])]
        .filter((id) => before === null || id < before)
        .sort()
        .reverse()
        .slice(0, limit)
        .map((id) => state.articles.get(id))
        .filter((article) => article !== undefined)
        .map((article) => viewOf(article))
        .filter((view): view is ArticleView => view !== null)
        .map(cardOf);
    },
    async countFor(principalId) {
      return [...(state.readingList.get(principalId) ?? [])].filter(
        (id) => state.articles.get(id)?.status === "published",
      ).length;
    },
    save: (principalId, articleId) =>
      asWrite(() => {
        const saved = state.readingList.get(principalId) ?? new Set<string>();
        saved.add(articleId);
        state.readingList.set(principalId, saved);
        return 1;
      }),
    remove: (principalId, articleId) =>
      asWrite(() => {
        state.readingList.get(principalId)?.delete(articleId);
        return 1;
      }),
    removeAllFor: (principalId) =>
      asWrite(() => {
        state.readingList.delete(principalId);
        return 1;
      }),
  };

  const media: MediaRepo = {
    async listStalePending(cutoff, limit) {
      return [...state.media.values()]
        .filter((record) => record.status === "pending" && record.createdAt < cutoff)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((record) => record.id);
    },
    async listCollectable(cutoff, limit) {
      const referenced = new Set<string>();
      for (const principal of state.principals.values()) {
        if (principal.avatarMediaId !== null && principal.avatarMediaId !== undefined) {
          referenced.add(principal.avatarMediaId);
        }
      }
      for (const article of state.articles.values()) {
        if (article.featuredMediaId !== null && article.featuredMediaId !== undefined) {
          referenced.add(article.featuredMediaId);
        }
      }
      return [...state.media.values()]
        .filter(
          (record) =>
            record.status === "removed" &&
            record.removedAt !== null &&
            record.removedAt !== undefined &&
            record.removedAt < cutoff &&
            !referenced.has(record.id),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((record) => record.id);
    },

    markDetached(id, at) {
      return asWrite(() => {
        const record = state.media.get(id);
        if (record === undefined || record.status !== "ready") return 0;
        record.status = "removed";
        record.removedAt = at;
        return 1;
      });
    },

    deleteRecords(ids) {
      return asWrite(() => {
        for (const id of ids) state.media.delete(id);
        return ids.length;
      });
    },
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
  /** SPEC §9.3 — the second channel, in memory. */
  const telegram: TelegramRepo = {
    insertLink: (link) => asWrite(() => void state.telegramLinks.set(link.nonce, { ...link, usedAt: null })),
    async findLink(nonce) {
      return state.telegramLinks.get(nonce) ?? null;
    },
    markLinkUsed: (nonce, at) =>
      asWrite(() => {
        const link = state.telegramLinks.get(nonce);
        // The guard the D1 statement carries in its WHERE: only an unused row is marked, so
        // two redemptions race and one of them writes nothing.
        if (link === undefined || link.usedAt !== null) return 0;
        link.usedAt = at;
        return 1;
      }),
    async findActiveLink(principalId, now) {
      return (
        [...state.telegramLinks.values()]
          .filter((link) => link.principalId === principalId && link.usedAt === null && link.expiresAt > now)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
      );
    },
    async findByPrincipal(principalId) {
      return state.telegramAccounts.get(principalId) ?? null;
    },
    async findByTelegramUser(telegramUserId) {
      return (
        [...state.telegramAccounts.values()].find((one) => one.telegramUserId === telegramUserId) ?? null
      );
    },
    upsertAccount: (account) => asWrite(() => void state.telegramAccounts.set(account.principalId, account)),
    deleteAccount: (principalId) => asWrite(() => void state.telegramAccounts.delete(principalId)),
    async listPendingNotifications(cutoff, limit) {
      const delivered = state.telegramDeliveries;
      return state.events
        .filter(
          (event) =>
            event.visibility === "private" &&
            event.audiencePrincipalId !== null &&
            event.audiencePrincipalId !== undefined &&
            event.createdAt > cutoff &&
            !delivered.has(event.id),
        )
        .flatMap((event) => {
          // §7.2 — an agent has no Telegram; its owner is the person accountable for it.
          const audience = state.principals.get(event.audiencePrincipalId!);
          const recipientId = audience?.ownerPrincipalId ?? audience?.id;
          const account = recipientId === undefined ? undefined : state.telegramAccounts.get(recipientId);
          return account === undefined
            ? []
            : [
                {
                  eventId: event.id,
                  type: event.type,
                  chatId: account.chatId,
                  recipientPrincipalId: account.principalId,
                  subjectType: event.subjectType,
                  subjectId: event.subjectId,
                  payload: (event.payload ?? null) as Record<string, unknown> | null,
                  createdAt: event.createdAt,
                },
              ];
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    },
    markDelivered: (eventId, at) => asWrite(() => void state.telegramDeliveries.set(eventId, at)),

    insertLogin: (login) => asWrite(() => void state.telegramLogins.set(login.nonce, { ...login, usedAt: null })),
    async findLogin(nonce) {
      return state.telegramLogins.get(nonce) ?? null;
    },
    markLoginUsed: (nonce, at) =>
      asWrite(() => {
        const login = state.telegramLogins.get(nonce);
        if (login === undefined || login.usedAt !== null) return 0;
        login.usedAt = at;
        return 1;
      }),

    recordLoginMessage: (nonce, messageId) =>
      asWrite(() => {
        const login = state.telegramLogins.get(nonce);
        if (login === undefined) return 0;
        login.messageId = messageId;
        return 1;
      }),
    async listSpentLoginMessages(limit) {
      return [...state.telegramLogins.values()]
        .filter(
          (login) =>
            login.usedAt !== null &&
            (login.cleanedAt === null || login.cleanedAt === undefined) &&
            login.messageId !== null &&
            login.messageId !== undefined,
        )
        .slice(0, limit)
        .map((login) => ({ nonce: login.nonce, chatId: login.chatId, messageId: login.messageId! }));
    },
    markLoginCleaned: (nonce, at) =>
      asWrite(() => {
        const login = state.telegramLogins.get(nonce);
        if (login === undefined) return 0;
        login.cleanedAt = at;
        return 1;
      }),

    async deleteLinksBefore(cutoff, limit) {
      let deleted = 0;
      for (const [nonce, link] of [...state.telegramLinks.entries()]) {
        if (deleted >= limit) break;
        if (link.expiresAt < cutoff) {
          state.telegramLinks.delete(nonce);
          deleted += 1;
        }
      }
      return deleted;
    },

    async deleteLoginsBefore(cutoff, limit) {
      let deleted = 0;
      for (const [nonce, login] of [...state.telegramLogins.entries()]) {
        if (deleted >= limit) break;
        // The expiry alone, as the SQL is: a spent login whose message was never taken back
        // is collected too, and the double must refuse nothing the real one collects.
        if (login.expiresAt < cutoff) {
          state.telegramLogins.delete(nonce);
          deleted += 1;
        }
      }
      return deleted;
    },

    async deleteDeliveriesBefore(cutoff, limit) {
      let deleted = 0;
      for (const [eventId, sentAt] of [...state.telegramDeliveries.entries()]) {
        if (deleted >= limit) break;
        if (sentAt < cutoff) {
          state.telegramDeliveries.delete(eventId);
          deleted += 1;
        }
      }
      return deleted;
    },
  };

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
    async putDerived(key, body) {
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) chunks.push(value);
      }
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      state.mediaBytes.set(key, bytes);
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
    async deleteAll(idPrefix) {
      let deleted = 0;
      for (const key of [...state.mediaBytes.keys()]) {
        if (key.startsWith(idPrefix)) {
          state.mediaBytes.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
  };

  /**
   * §9.2, §23.5 — the browser credentials, as far as the API surface needs them.
   *
   * Only what account closure uses. `memory-auth.ts` holds the full doubles for the passkey
   * ceremony; duplicating those here would give two stores that could disagree about
   * whether somebody is signed in.
   */
  const credentials: CredentialRepo = {
    async findByCredentialId() {
      return null;
    },
    async listFor(principalId) {
      return state.credentials.filter((record) => record.principalId === principalId);
    },
    insert: (credential) =>
      asWrite(() => void state.credentials.push({ ...credential, lastUsedAt: null })),
    recordUse: () => asWrite(() => 1),
    deleteOne: (id, principalId) =>
      asWrite(() => {
        const before = state.credentials.length;
        state.credentials = state.credentials.filter(
          (record) => !(record.id === id && record.principalId === principalId),
        );
        return before - state.credentials.length;
      }),
    deleteAllFor: (principalId) =>
      asWrite(() => {
        const before = state.credentials.length;
        state.credentials = state.credentials.filter((record) => record.principalId !== principalId);
        return before - state.credentials.length;
      }),
  };

  const sessions: SessionRepo = {
    async findByHash(tokenHash) {
      return state.sessions.find((entry) => entry.tokenHash === tokenHash) ?? null;
    },
    async listFor(principalId) {
      return state.sessions.filter(
        (entry) => entry.principalId === principalId && entry.revokedAt === null,
      );
    },
    insert: (session) => asWrite(() => void state.sessions.push(session)),
    touch: () => asWrite(() => 1),
    revoke: (id, at) =>
      asWrite(() => {
        const session = state.sessions.find((entry) => entry.id === id);
        if (session !== undefined) session.revokedAt = at;
        return 1;
      }),
    revokeAllFor: (principalId, at) =>
      asWrite(() => {
        let n = 0;
        for (const session of state.sessions) {
          if (session.principalId === principalId && session.revokedAt === null) {
            session.revokedAt = at;
            n += 1;
          }
        }
        return n;
      }),
    async deleteDeadBefore(cutoff, limit) {
      const dead = state.sessions.filter(
        (session) =>
          (session.revokedAt !== null && session.revokedAt < cutoff) || session.expiresAt < cutoff,
      );
      for (const session of dead.slice(0, limit)) {
        state.sessions.splice(state.sessions.indexOf(session), 1);
      }
      return Math.min(dead.length, limit);
    },
  };

  /** The same filter the listing and the count share in SQL, for the same reason. */
  const matchesReport = (report: ReportRecord, query: ReportQuery): boolean =>
    (query.status === null || query.status.length === 0 || query.status.includes(report.status)) &&
    (query.targetType === null || report.targetType === query.targetType);

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

    async describeReporters(ids) {
      return [...new Set(ids)].flatMap((id) => {
        const principal = state.principals.get(id);
        return principal === undefined ? [] : [{ id, username: principal.username }];
      });
    },

    async findOpenReportBy(reporterPrincipalId, targetType, targetId) {
      const open = state.reports.filter(
        (report) =>
          report.targetType === targetType &&
          report.targetId === targetId &&
          report.reporterPrincipalId === reporterPrincipalId &&
          (report.status === "open" || report.status === "reviewing"),
      );
      return open[open.length - 1] ?? null;
    },

    async listReports(query) {
      // The cursor compares in the direction the page runs, exactly as the SQL does. A
      // double that always walks forwards agrees with the adapter until somebody pages back.
      const forwards = (query.order ?? "oldest") === "oldest";
      return state.reports
        .filter(
          (report) =>
            matchesReport(report, query) &&
            (query.after === null ||
              (forwards ? report.id > query.after : report.id < query.after)),
        )
        .sort((a, b) => (forwards ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)))
        .slice(0, query.limit);
    },
    async countReports(query) {
      return state.reports.filter((report) => matchesReport(report, query)).length;
    },
    async findReport(id) {
      return state.reports.find((report) => report.id === id) ?? null;
    },

    async listRecentActions(limit, before) {
      return state.moderationActions
        .filter((action) => before === null || action.id < before)
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, limit);
    },

    /**
     * The subject lines, from whatever this double happens to hold (§61.1).
     *
     * The article's title comes from its revision, like the real one; a comment reports its
     * opening words and the article it is on. A target the double does not know is described
     * as null rather than dropped, which is the contract the page depends on.
     */
    async describeTargets(targets) {
      return targets.map((target) => {
        if (target.targetType === "article") {
          const article = state.articles.get(target.targetId);
          const revisionId = article?.publishedRevisionId ?? article?.currentRevisionId ?? null;
          const revision = revisionId === null ? undefined : state.revisions.get(revisionId);
          return {
            ...target,
            label: revision?.title ?? null,
            articleId: article?.id ?? null,
            username: null,
            screening: article?.moderationState ?? null,
          };
        }
        if (target.targetType === "comment") {
          const comment = state.comments.get(target.targetId);
          return {
            ...target,
            label: comment?.contentMarkdown.slice(0, 120) ?? null,
            articleId: comment?.articleId ?? null,
            username: null,
            screening: null,
          };
        }
        if (target.targetType === "principal") {
          const principal = state.principals.get(target.targetId);
          return {
            ...target,
            label: principal === undefined ? null : (principal.displayName ?? `@${principal.username}`),
            articleId: null,
            username: principal?.username ?? null,
            screening: null,
          };
        }
        return { ...target, label: null, articleId: null, username: null, screening: null };
      });
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

  /**
   * SPEC §51 — the shard table and the asset bucket, in memory.
   *
   * `articlesIn` repeats the adapter's eligibility conditions rather than sharing them,
   * which is the one duplication the doubles accept: a test that passes here and fails
   * against D1 is worth more than a test that cannot tell the two apart.
   */
  const sitemap: SitemapRepo = {
    async markDirty(shard) {
      const existing = state.sitemapShards.get(shard);
      state.sitemapShards.set(shard, {
        dirty: true,
        urlCount: existing?.urlCount ?? 0,
        builtAt: existing?.builtAt ?? null,
      });
    },
    async dirtyShards(limit) {
      return [...state.sitemapShards.entries()]
        .filter(([, value]) => value.dirty)
        .map(([shard]) => shard)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, limit);
    },
    async articlesIn(shard, limit) {
      return [...state.articles.values()]
        .filter(
          (article) =>
            article.publishedAt !== null &&
            article.publishedAt.slice(0, 7) === shard &&
            article.status === "published" &&
            article.visibility === "public" &&
            article.indexable &&
            article.canonicalUrl === null,
        )
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
        .slice(0, limit)
        .map((article) => ({
          id: article.id,
          publishedAt: article.publishedAt!,
          updatedAt: article.updatedAt,
        }));
    },
    async markBuilt(shard, urlCount, at) {
      state.sitemapShards.set(shard, { dirty: false, urlCount, builtAt: at });
    },
    async shards() {
      return [...state.sitemapShards.entries()]
        .map(([shard, value]) => ({ shard, urlCount: value.urlCount, builtAt: value.builtAt }))
        .sort((a, b) => b.shard.localeCompare(a.shard));
    },
  };

  const assets: AssetStore = {
    async put(key, body) {
      state.assets.set(key, body);
    },
    async get(key) {
      return state.assets.get(key) ?? null;
    },
  };

  /**
   * SPEC §66.4 — the operator's read model, in memory.
   *
   * `databaseBytes` answers null, which is what a platform that does not report a size does.
   * The service turns that into "unavailable" rather than into health, and a test that ran
   * against a double reporting a comfortable zero would prove the opposite of what it should.
   */
  const slo: SloRepo = {
    async outboxBacklog() {
      // `sentOutbox` is where this double records delivery, as `listPending` above does.
      const pending = state.outbox.filter((entry) => !sentOutbox.has(entry.id));
      const oldest = pending.map((entry) => entry.createdAt).sort()[0];
      return { pending: pending.length, oldestPendingAt: oldest ?? null };
    },
    async indexingLag(sample: number) {
      const seconds = [...state.searchIndexedAt.entries()]
        .map(([articleId, indexedAt]) => {
          const article = state.articles.get(articleId);
          if (article === undefined || article.publishedAt === null) return null;
          return (Date.parse(indexedAt) - Date.parse(article.publishedAt)) / 1000;
        })
        .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
        .slice(-sample)
        .sort((a, b) => a - b);

      if (seconds.length === 0) return { sampled: 0, p95Seconds: null };
      const rank = Math.max(0, Math.ceil(seconds.length * 0.95) - 1);
      return { sampled: seconds.length, p95Seconds: seconds[rank] ?? null };
    },
    async deadLettered(since: string) {
      return state.deadLetters.filter((at) => at >= since).length;
    },
    async databaseBytes() {
      return null;
    },
    async deleteDeadLettersBefore(cutoff: string, limit: number) {
      const doomed = state.deadLetters.filter((at) => at < cutoff).slice(0, limit);
      for (const at of doomed) state.deadLetters.splice(state.deadLetters.indexOf(at), 1);
      return doomed.length;
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
    // §66.2 — a metric never fails a request, so the double counts and returns.
    metrics: { write: (event) => void state.metrics.push(event) },
    // §23.5 — a closure has to revoke every way in. The doubles are the same shape as the
    // real repos, so a test that forgets one fails here rather than in production.
    credentials,
    sessions,
    social,
    search,
    embeddings,
    topics,
    topicAssignments,
    readingList,
    media,
    mediaStore,
    /** No platform here: §21.2's fallback is the behaviour a domain test should see. */
    transform: { produce: async () => null },
    moderation,
    telegram,
    sitemap,
    slo,
    assets,
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
