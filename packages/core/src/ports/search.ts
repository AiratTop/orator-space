import type { OratorId } from "@orator/protocol";

/**
 * Search (SPEC §38).
 *
 * Deliberately not a repository. Everything else the domain writes goes through
 * `PendingWrite` and a commit, because it has to be transactional with something else.
 * The index is the opposite: §38.1 keeps it *out* of the publishing transaction, so that
 * a slow or failing index cannot lengthen or break the critical path of publishing. It is
 * updated from the event handler afterwards, and it is rebuildable from `revisions` plus
 * content storage at any time — which is what makes that safe.
 *
 * The consequence is stated to callers rather than hidden: a freshly published article is
 * readable at once and searchable shortly after (§34.4).
 */

export interface SearchDocument {
  articleId: OratorId;
  title: string;
  excerpt: string;
  /** Truncated before it gets here — the index shares D1's size ceiling (§31.3). */
  body: string;
  author: string;
  topics: string;
  /** What the entry was built from, so a reindex can skip what has not changed. */
  contentHash: string;
}

export interface SearchIndex {
  index(document: SearchDocument, at: string): Promise<void>;
  remove(articleId: string): Promise<void>;
  /** Null when the article is not indexed. Compared against the current hash. */
  indexedHash(articleId: string): Promise<string | null>;
  query(text: string, limit: number): Promise<OratorId[]>;
}
