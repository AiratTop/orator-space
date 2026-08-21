import type { FeedCursor, OratorId } from "@orator/protocol";
import type { ArticleRecord, Disclosure, RevisionRecord } from "./articles.js";

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
}

export interface ArticleView {
  article: ArticleRecord;
  revision: RevisionRecord;
  author: AuthorSummary;
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

export interface FeedPage {
  cards: ArticleCard[];
  /** Null when the feed ends here — the caller never guesses from the page size. */
  next: FeedCursor | null;
}

export interface ReadingRepo {
  /** Published, public articles only. A draft or a removed article reads as absent. */
  findPublished(id: string): Promise<ArticleView | null>;
  /** SPEC §37.1 — the one feed that needs no materialisation; it is an index scan. */
  listLatest(limit: number, before: FeedCursor | null): Promise<FeedPage>;
  listByAuthor(principalId: string, limit: number, before: FeedCursor | null): Promise<FeedPage>;
  findPrincipalByUsername(username: string): Promise<AuthorSummary | null>;
}
