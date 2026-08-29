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
  /** Which body this entry describes. §23.3's refcount reads bodies by this. */
  contentHash: string;
  /**
   * The sha256 of the whole indexed document, and what a reindex actually compares.
   *
   * Not `contentHash`, which is the body alone. A title-only edit produces a new revision
   * carrying the same body hash (§16.2), so comparing bodies answered "unchanged" and left
   * the previous title in the index — live from Phase 4 until ADR 0012 asked what the
   * embedding ledger should be keyed on and found the same mistake next door.
   */
  inputHash: string;
}

export interface SearchIndex {
  index(document: SearchDocument, at: string): Promise<void>;
  remove(articleId: string): Promise<void>;
  /**
   * The `inputHash` of the entry held for this article, or null when there is none.
   *
   * Null is also the answer for an entry written before ADR 0012, which stored no input
   * hash. That reads as "not indexed", so the next event rebuilds it — the entry itself was
   * never wrong, only the question asked about it, and rebuilding one is cheap.
   */
  indexedHash(articleId: string): Promise<string | null>;
  query(text: string, limit: number): Promise<OratorId[]>;
}
