import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/** SPEC §15, §16 — articles hold pointers and metadata; revisions hold content. */

export type ArticleStatus = "draft" | "published" | "unpublished" | "removed";
export type Visibility = "public" | "unlisted" | "private";
export type Disclosure = "human_authored" | "ai_assisted" | "ai_generated";

export interface ArticleRecord {
  id: OratorId;
  authorPrincipalId: OratorId;
  status: ArticleStatus;
  visibility: Visibility;
  currentRevisionId: OratorId | null;
  publishedRevisionId: OratorId | null;
  language: string;
  translationGroupId: string | null;
  authorshipDisclosure: Disclosure;
  indexable: boolean;
  /** SPEC §60.1 — the article this one is byte-identical to, or null. */
  duplicateOf?: OratorId | null;
  /**
   * SPEC §50.1, §21.2 — the image this article is previewed by, or null.
   *
   * A column since the first migration and unwritten until now. It is the article's own
   * picture: the `social` variant of it is the `og:image`, and the site's default card is what
   * stands in when there is none.
   */
  featuredMediaId?: OratorId | null;
  canonicalUrl: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  removedAt: string | null;
  /**
   * SPEC §23.2, §61.1 — why the article is gone, when it is.
   *
   * A tombstone answers 410 and a legal takedown answers 451, and those are different
   * statements to a crawler, to a citing author and to a court. Null while the article is
   * present.
   */
  removalSource: "author" | "moderation" | "legal" | null;
  /**
   * SPEC §61, §50.3 — whether the article has been screened, and what was found.
   *
   * Three states, not a boolean: "not checked yet" and "checked and clean" have to be
   * distinguishable, because an unavailable provider leaves content `unchecked` and
   * therefore not indexable, rather than published as checked.
   */
  moderationState: "unchecked" | "passed" | "flagged";
  moderationVerdict: string | null;
  moderatedAt: string | null;
  /** SPEC §60.1 — the near-duplicate fingerprint, 16 hex characters. Null before screening. */
  simhash: string | null;
  /**
   * SPEC §50.3 — why the article is or is not indexed.
   *
   * Without it, `indexable = 0` cannot be told apart from "not evaluated yet", and an author
   * asking why their article is not in search has no answer.
   */
  indexableReason: string | null;
  /** Joined from the authoring agent, for authorisation (SPEC §43.2). */
  authorOwnerPrincipalId?: OratorId;
  /**
   * The author's handle, joined in the same query.
   *
   * Not decoration: §58.2's envelope names who wrote the content, and a label that cannot
   * say who is a weaker label. The join is on a primary key in a query that already runs.
   */
  authorUsername: string;
}

export interface RevisionRecord {
  /** SPEC §16.3 — when this revision became the public text, or null if it never did. */
  publishedAt?: string | null;
  id: OratorId;
  articleId: OratorId;
  parentRevisionId: OratorId | null;
  title: string;
  excerpt: string | null;
  contentRef: string;
  contentHash: string;
  contentBytes: number;
  readingTimeSeconds: number | null;
  metadata: Record<string, unknown>;
  createdByPrincipalId: OratorId;
  signature: string | null;
  signatureKeyId: OratorId | null;
  createdAt: string;
}

export interface NewArticle {
  id: OratorId;
  authorPrincipalId: OratorId;
  language: string;
  authorshipDisclosure: Disclosure;
  visibility: Visibility;
  /** SPEC §15.1 — set at creation on import, so no window exists in which a copy competes. */
  canonicalUrl: string | null;
  createdAt: string;
}

export interface NewRevision {
  id: OratorId;
  articleId: OratorId;
  parentRevisionId: OratorId | null;
  title: string;
  excerpt: string | null;
  contentRef: string;
  contentHash: string;
  contentBytes: number;
  readingTimeSeconds: number | null;
  metadata: Record<string, unknown> & { schema_version: number };
  createdByPrincipalId: OratorId;
  viaTokenId: string | null;
  createdAt: string;
}

export interface ArticleRepo {
  findById(id: string): Promise<ArticleRecord | null>;
  findRevision(id: string): Promise<RevisionRecord | null>;
  listRevisions(articleId: string, limit: number): Promise<RevisionRecord[]>;
  /** Every revision sharing a body — erasure must check this before deleting (SPEC §23.3). */
  countRevisionsWithContent(contentHash: string): Promise<number>;

  insertArticle(article: NewArticle): PendingWrite;
  insertRevision(revision: NewRevision): PendingWrite;

  /**
   * Moves `current_revision_id`, but only if it still holds `expectedRevisionId`.
   * A zero row count is the conflict signal for `If-Match` (SPEC §34.3).
   */
  setCurrentRevision(
    articleId: string,
    revisionId: OratorId,
    expectedRevisionId: string | null,
    updatedAt: string,
  ): PendingWrite;

  /**
   * Publishing is a pointer move, never a copy (SPEC §16.3).
   *
   * `publishedAt` is separate from `at` because they are separate facts: `at` is when this
   * happened, `publishedAt` is the date the article claims. They differ on import (§15.1),
   * where the article was first published somewhere else years ago.
   */
  publish(articleId: string, revisionId: string, at: string, publishedAt: string): PendingWrite;
  /**
   * Marks a revision as having been published (SPEC §16.3, §49.2).
   *
   * Separate from `publish`, and written in the same transaction. Publishing moves a pointer;
   * this records that the thing pointed at was, at some moment, the public text — which is
   * the only way to tell a superseded version from a draft the author never published. A
   * history built without the distinction publishes work somebody chose not to publish.
   */
  markRevisionPublished(revisionId: string, at: string): PendingWrite;
  unpublish(articleId: string, at: string): PendingWrite;
  /** `removalSource` is required when the status is `removed`, and ignored otherwise. */
  setStatus(
    articleId: string,
    status: ArticleStatus,
    at: string,
    removalSource?: ArticleRecord["removalSource"],
  ): PendingWrite;
  /**
   * SPEC §50.3, §60.1 — the outcome of one indexability evaluation.
   *
   * The fingerprint and the verdict move together because they are computed together and a
   * fingerprint without a verdict is a row nothing will ever revisit.
   */
  setIndexability(
    articleId: string,
    fields: {
      indexable: boolean;
      reason: string;
      simhash: string | null;
      /**
       * SPEC §60.1 — the article this one is a copy of, or null.
       *
       * A column rather than a substring of `reason`, so the fact survives whichever
       * condition happened to win the race to explain the article — a duplicate by an author
       * whose trust has not risen used to be recorded as `untrusted_author` and nothing else.
       */
      duplicateOf: string | null;
    },
    at: string,
  ): PendingWrite;

  /**
   * SPEC §60.1 — the earliest published article with this exact body, if there is one.
   *
   * Free next to the simhash path: `content_hash` is already on every revision and is already
   * unique per body, so this is an index seek where a near-duplicate needs a fingerprint and
   * four band lookups. An identical body took the expensive route until now, and only after
   * five earlier conditions had passed.
   *
   * Strictly earlier, not merely different. Ids are time-ordered (§12.2), so this asks
   * "published before this one" — and the earliest of a set therefore finds nothing and is
   * nobody's copy, which is what makes the relation a direction rather than a pair.
   */
  findByContentHash(contentHash: string, before: string): Promise<{ id: OratorId } | null>;

  /**
   * SPEC §60.1 — published articles whose fingerprint shares a band with this one.
   *
   * Candidates, not duplicates: the caller computes the exact distance. Bounded, because a
   * band collision is cheap and a pathological one should cost a bounded amount of work
   * rather than a table's worth.
   */
  findBySimhashBands(
    bands: readonly number[],
    excludeArticleId: string,
    limit: number,
  ): Promise<{ id: OratorId; simhash: string }[]>;

  /**
   * SPEC §23.5 — the articles an author has, for a closure to act on.
   *
   * The write-side repo rather than the read model: this has to see drafts and unpublished
   * work, which `ReadingRepo` deliberately cannot (§49). Bounded, because a closure applies
   * its disposition in passes.
   */
  listByAuthor(authorPrincipalId: string, limit: number): Promise<ArticleRecord[]>;

  /**
   * SPEC §66.7 — articles belonging to a system account, older than a cutoff.
   *
   * For the retention pass that clears what an unhealthy deep check left behind. Ordinary
   * articles are never hard-deleted (§23.2); these were never citable.
   */
  listSystemArticlesBefore(cutoff: string, limit: number): Promise<string[]>;
  /**
   * Two statements, in order: the revisions and then the articles.
   *
   * `revisions.article_id` is a declared foreign key with `NO ACTION` (§7.4) — this schema
   * has no cascades on purpose, because a delete nobody can see is a delete nobody audits.
   * So the order is the caller's to get right, and it is expressed here rather than left to
   * whoever writes the batch.
   */
  deleteArticles(ids: readonly string[]): PendingWrite[];

  /** SPEC §61 — the outcome of a screening pass, written by the queue consumer. */
  setModerationState(
    articleId: string,
    state: ArticleRecord["moderationState"],
    verdict: string | null,
    at: string,
  ): PendingWrite;
  /** SPEC §44.2 — merge semantics. Only the fields present are touched. */
  updateMetadata(
    articleId: string,
    fields: {
      visibility?: Visibility;
      authorshipDisclosure?: Disclosure;
      canonicalUrl?: string | null;
      language?: string;
      indexable?: boolean;
      /** SPEC §50.1 — null clears it; absent leaves it alone (§44.2's merge semantics). */
      featuredMediaId?: string | null;
    },
    at: string,
  ): PendingWrite;
  /**
   * SPEC §23.3 — the one write that destroys something.
   *
   * Blanks `content_ref`, `title` and `excerpt` while keeping the row, the id and the
   * hash. Immutability means history is not rewritten unnoticed; it does not mean data
   * cannot be erased on a lawful demand, and what remains is the verifiable trace.
   */
  eraseRevision(revisionId: string, at: string): PendingWrite;
  attachSignature(revisionId: string, signature: string, keyId: string): PendingWrite;
}

/** SPEC §34.1 — replaying a request must not produce a second article. */
export interface IdempotencyRecord {
  key: string;
  principalId: string;
  endpoint: string;
  requestHash: string;
  status: "in_progress" | "completed";
  responseStatus: number | null;
  responseJson: string | null;
  createdAt: string;
}

export interface IdempotencyRepo {
  find(principalId: string, key: string): Promise<IdempotencyRecord | null>;
  /** Zero rows means the key was already claimed — the concurrency signal. */
  claim(record: Omit<IdempotencyRecord, "status" | "responseStatus" | "responseJson">): PendingWrite;
  complete(principalId: string, key: string, status: number, body: string): PendingWrite;
  release(principalId: string, key: string): PendingWrite;
  /** SPEC §23.4 — twenty-four hours. A key older than that protects nothing. */
  deleteBefore(cutoff: string, limit: number): Promise<number>;
}

/** SPEC §20 — notifications and public activity. */
export interface NewEvent {
  id: OratorId;
  type: string;
  actorPrincipalId: OratorId | null;
  subjectType: "article" | "comment" | "principal" | "media";
  subjectId: string;
  audiencePrincipalId: OratorId | null;
  visibility: "public" | "private";
  payload: Record<string, unknown> & { schema_version: number };
  createdAt: string;
}

export interface EventRepo {
  insert(event: NewEvent): PendingWrite;
  listForAudience(principalId: string, since: string | null, limit: number): Promise<NewEvent[]>;
  listForSubject(subjectType: string, subjectId: string, limit: number): Promise<NewEvent[]>;
}
