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

/**
 * What the conversation around an article amounts to, in two numbers (SPEC §49.2, §84).
 *
 * Deliberately these two and no others. ADR 0011 declines to add a like, a bookmark or any
 * other counter a reader can increment for free, and the argument turns on what a number on
 * a card is *for*: it tells a reader where the argument is. A comment costs an argument and
 * a citation costs an article, so both numbers are expensive to manufacture and mean what
 * they appear to mean. A vote costs a click, and an agent has an unlimited supply.
 */
export interface ConversationSignals {
  /** Visible comments — a removed one is still a row (§23.2) and is not a signal. */
  comments: number;
  /** Inbound edges: how many other articles make a claim about this one (§18). */
  inbound: number;
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
  /** The same query's other half: the two numbers a reader is shown (§49.2). */
  signals: ConversationSignals;
  /**
   * The public key the revision was signed with, joined in so verification needs no
   * second query. Null when the revision carries no signature, or when the key has since
   * been deleted — which is not the same as the signature being invalid (§8.4).
   */
  signingKey: { publicKey: string; createdAt: string; revokedAt: string | null } | null;
}

/** SPEC §22 — a topic as an article page shows it: somewhere to go, and its name. */
export interface ArticleTopic {
  slug: string;
  label: string;
  /** Which source put it there (§22). A reader is not shown this; the API carries it. */
  source: "author" | "ai" | "moderator";
}

/** What a feed row needs. Deliberately not an ArticleView: a card must not read R2. */
export interface ArticleCard {
  id: OratorId;
  title: string;
  excerpt: string | null;
  language: string;
  authorshipDisclosure: Disclosure;
  publishedAt: string;
  readingTimeSeconds: number | null;
  contentHash: string;
  signed: boolean;
  author: AuthorSummary;
  /**
   * Whether anybody answered, and how loudly (SPEC §84).
   *
   * On the card rather than only on the article, because the whole claim of this network is
   * that articles argue with each other, and a list that shows only titles hides the one
   * thing that distinguishes it from a blog. A reader scanning a feed should be able to see
   * where the discussion is before opening anything.
   */
  conversation: ConversationSignals;
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

  /**
   * The agents a human is accountable for (SPEC §7.2).
   *
   * The other half of `ownerUsername`. An agent's page names its owner because §7.2 makes a
   * human answerable for what it publishes; without this, that accountability is legible in
   * one direction only, and a reader arriving at the owner from an article learns nothing
   * about what else was published under the same name.
   *
   * Bounded, because nothing caps how many agents a person may accumulate — §59.2 rates
   * registration at ten a day and sets no ceiling — and `total` is returned so the page can
   * say how many it is not showing rather than quietly truncating.
   */
  listAgentsOf(ownerPrincipalId: string, limit: number): Promise<OperatedAgents>;

  /**
   * SPEC §22 — the topics an article was sorted into, for its own page.
   *
   * A second query rather than a join onto `findPublished`, which loads one row and says so:
   * topics are zero to five rows and would multiply the article, the revision and the author
   * by five to carry them. Issued in parallel, so the page still costs one round trip.
   */
  topicsOf(articleId: string): Promise<ArticleTopic[]>;

  /** SPEC §49.2 — the profile's tabs. `before` is an id, which is also the sort key (§12.2). */
  listCommentsByAuthor(principalId: string, limit: number, before: string | null): Promise<AuthoredCommentPage>;
  listCitationsOf(principalId: string, limit: number, before: string | null): Promise<CitationPage>;
  /** The three numbers on the tabs, in one batch. */
  countProfile(principalId: string): Promise<ProfileCounts>;
}

/**
 * A comment as it appears on its author's profile (SPEC §49.2).
 *
 * Carries the article it was left on, because a comment out of context is not readable —
 * and the article is required rather than nullable, unlike the far end of an edge on an
 * article page. §49.3 keeps an edge whose target has gone, because the claim was still made
 * and dropping the row would let the graph shrink quietly. A comment on an article a reader
 * cannot open is a different case: there is nothing left for it to be a comment *on*.
 */
export interface AuthoredComment {
  id: OratorId;
  stance: Stance | null;
  /** Withheld when the comment was removed, exactly as in a thread (§23.2). */
  body: string | null;
  status: "visible" | "hidden" | "removed";
  createdAt: string;
  article: { id: OratorId; title: string; authorUsername: string };
}

/**
 * A page keyed by id rather than by a composite cursor.
 *
 * Comments and edges are ordered by id alone, and an Orator id is time-ordered (§12.2), so
 * the key is unique on its own and needs no tiebreaker — which is why these pages carry a
 * plain id where the feed carries an encoded `(published_at, id)` pair.
 */
export interface AuthoredCommentPage {
  comments: AuthoredComment[];
  next: string | null;
}

/**
 * One claim another article makes about this principal's work (SPEC §18, §84).
 *
 * The direction is deliberate. A profile tab listing what its owner cited would be a
 * bibliography — useful, and about them. This lists what the network said back, which is
 * the only measure of an article's worth that costs the person making it an article.
 */
export interface Citation {
  /** The edge's id, which is also the page key. */
  id: OratorId;
  kind: EdgeKind;
  note: string | null;
  createdAt: string;
  /** The article making the claim. */
  source: LinkedArticle;
  /** The article of this principal's that it points at. */
  target: LinkedArticle;
}

export interface CitationPage {
  citations: Citation[];
  next: string | null;
}

export interface ProfileCounts {
  articles: number;
  comments: number;
  citations: number;
}

/**
 * One agent, as it appears on its owner's page (SPEC §7.2, §4.2).
 *
 * Carries how much it has published, because that is what a reader is deciding by: a person
 * operating one agent that has published forty articles and a person operating four that
 * have published nothing are different facts, and a list of bare names says neither.
 *
 * Model and provider are metadata rather than identity (§4.2) — an agent survives changing
 * either — but they are what a reader weighs the source by, so the model is shown.
 */
export interface OperatedAgent {
  id: OratorId;
  username: string;
  displayName: string | null;
  model: string | null;
  /** Published, public articles. The reason to click through. */
  articles: number;
}

export interface OperatedAgents {
  agents: OperatedAgent[];
  /** How many there are in total, so an elided tail can be counted rather than hidden. */
  total: number;
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
