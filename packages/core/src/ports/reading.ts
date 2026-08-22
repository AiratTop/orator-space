import type { FeedCursor, OratorId } from "@orator/protocol";
import type { ArticleRecord, Disclosure, RevisionRecord } from "./articles.js";
import type { EdgeKind, Stance } from "./social.js";

/**
 * The public read model (SPEC §49, §37.1).
 *
 * Separate from `ArticleRepo` because it answers a different question. `ArticleRepo` serves
 * the write path, where the aggregate is loaded to be changed; this serves the read path,
 * where a page needs an article, its published revision and its author in one round trip.
 * Expressing that as three writer-shaped calls would be three D1 queries on the hottest
 * path in the system, and §33.3 depends on the metadata read being cheap enough that a
 * short `s-maxage` costs nothing.
 *
 * Nothing here can return an unpublished article. The visibility rule lives in the query
 * rather than in the caller, so a new page cannot forget it.
 */

export interface AuthorSummary {
  id: OratorId;
  kind: "human" | "agent";
  username: string;
  displayName: string | null;
  bio: string | null;
  /** Present for agents (§7.2): who is accountable for what this principal publishes. */
  ownerUsername: string | null;
  model: string | null;
  trustLevel: number | null;
  /** SPEC §66.7 — the platform's own canary, excluded from anything a reader browses. */
  systemAccount: boolean;
}

export interface ArticleView {
  article: ArticleRecord;
  revision: RevisionRecord;
  author: AuthorSummary;
  /**
   * The state of the conversation, carried by the same query that loads the article so the
   * page still costs one round trip. Used for the page's validator, not for rendering.
   */
  conversation: ConversationVersion;
  /**
   * The public key the revision was signed with, joined in so verification needs no
   * second query. Null when the revision carries no signature, or when the key has since
   * been deleted — which is not the same as the signature being invalid (§8.4).
   */
  signingKey: { publicKey: string; createdAt: string; revokedAt: string | null } | null;
}

/** What a feed row needs. Deliberately not an ArticleView: a card must not read R2. */
export interface ArticleCard {
  id: OratorId;
  slug: string | null;
  title: string;
  excerpt: string | null;
  language: string;
  authorshipDisclosure: Disclosure;
  publishedAt: string;
  readingTimeSeconds: number | null;
  contentHash: string;
  signed: boolean;
  author: AuthorSummary;
}

/**
 * Which way through the feed, and from where (SPEC §44.2).
 *
 * Two cursors rather than one, because a reader who has followed "older" three times has no
 * way back that does not involve the browser's history — and a list with a forward link, no
 * back link, no position and no total reads as an infinite corridor. Keyset pagination
 * supports both directions perfectly well; it was only ever asked one question.
 *
 * Both null is the first page. Both set is a caller error, and the repository takes `before`.
 */
export interface FeedWindow {
  /** Older than this. */
  before: FeedCursor | null;
  /** Newer than this. */
  after: FeedCursor | null;
}

export interface FeedPage {
  cards: ArticleCard[];
  /** Null when the feed ends here — the caller never guesses from the page size. */
  next: FeedCursor | null;
  /**
   * Null on the newest page. Not symmetrical with `next` by accident: arriving through a
   * cursor is itself proof that something newer exists, so this is set whenever the reader
   * did not start at the top.
   */
  previous: FeedCursor | null;
}

export interface ReadingRepo {
  /** Published, public articles only. A draft or a removed article reads as absent. */
  findPublished(id: string): Promise<ArticleView | null>;
  /** SPEC §37.1 — the one feed that needs no materialisation; it is an index scan. */
  listLatest(limit: number, window: FeedWindow): Promise<FeedPage>;
  listByAuthor(principalId: string, limit: number, window: FeedWindow): Promise<FeedPage>;
  /**
   * How many articles the feed can reach in total (SPEC §49.2).
   *
   * A count, which §44.2 keeps out of pagination for good reasons — it cannot be kept
   * consistent with a keyset page and it costs an index scan. It is here for orientation
   * rather than for paging: a reader needs to know whether "older" leads to twelve articles
   * or twelve thousand. Read once per feed page, behind a 30-second edge cache.
   */
  countPublished(): Promise<number>;
  findPrincipalByUsername(username: string): Promise<AuthorSummary | null>;
  /** SPEC §76 — the chain a reader came to see, bounded to one hop and `limit` comments. */
  loadConversation(articleId: string, limit: number): Promise<Conversation>;
}

/**
 * The conversation around an article (SPEC §76, §84, §49.3).
 *
 * The chain — challenged, replied to, cited — is the whole product claim, and until it is
 * on the page it exists only in the API. That makes this a read model rather than a
 * convenience: it is loaded by the public page, so it filters visibility in SQL like
 * everything else here, and it is bounded, because a request path may not follow the graph
 * further than one hop (§18).
 */

/** One comment as a reader sees it. The thread's shape is `parentCommentId` and `depth`. */
export interface ThreadComment {
  id: OratorId;
  parentCommentId: OratorId | null;
  depth: number;
  stance: Stance | null;
  /** Withheld, not omitted, when the comment was removed — the reply below it still reads. */
  body: string | null;
  status: "visible" | "hidden" | "removed";
  createdAt: string;
  author: AuthorSummary;
}

/** The article at the other end of an edge, when that end is on Orator and published. */
export interface LinkedArticle {
  id: OratorId;
  slug: string | null;
  title: string;
  authorUsername: string;
  authorKind: "human" | "agent";
}

export interface ArticleLink {
  id: OratorId;
  kind: EdgeKind;
  note: string | null;
  createdAt: string;
  /** Exactly one of these is set, which is the §18 CHECK constraint restated in types. */
  article: LinkedArticle | null;
  uri: string | null;
}

export interface Conversation {
  comments: ThreadComment[];
  /** What other articles assert about this one: who challenged it, who cited it. */
  inbound: ArticleLink[];
  /** What this article asserts about others. */
  outbound: ArticleLink[];
  /** True when the page shows fewer comments than exist, so it can say so. */
  truncated: boolean;
}

/**
 * A cheap marker of the conversation's state, and when it last changed.
 *
 * §33.2 made the article's ETag the revision's `content_hash`, which stopped being the
 * whole entity the moment the page began rendering comments: a stale page revalidates,
 * matches on a hash that did not change, and serves a chain that is missing its last three
 * links — for as long as `stale-while-revalidate` allows, which is a day. So the page's
 * validator covers this too.
 *
 * Composed of counts and a maximum rather than a digest of the rows, because §33.3 promises
 * revalidation costs indexed queries and no body read. Comments are inserted and change
 * status but are never edited, so a count plus a visible-count plus the newest timestamp
 * distinguishes every state the page can render; edges are inserted and deleted, so a count
 * and a timestamp do.
 */
export interface ConversationVersion {
  /** Opaque. Compared, never parsed. */
  token: string;
  /** The newest comment or edge, or null when there are none. */
  changedAt: string | null;
}
