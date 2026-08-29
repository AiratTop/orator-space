import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/**
 * Semantic search (SPEC §38.2, §38.3, ADR 0012).
 *
 * Three interfaces rather than one, because the three things behind them fail separately and
 * the caller has to be able to tell which failed:
 *
 *   - `Embedder`        a model. Unavailable the way any model is, on any single call.
 *   - `VectorIndex`     a store. Reachable or not, and independent of the model.
 *   - `EmbeddingLedger` D1. What has already been embedded, so a redelivery costs nothing
 *     (§35.3) and a model change re-embeds the corpus without a script.
 *
 * The split is also what keeps §38.2's reversibility real. Leaving Vectorize replaces one of
 * these; changing the model replaces another; neither touches the domain, because everything
 * here speaks in article ids and numbers.
 */

/**
 * Text in, vectors out, in order (SPEC §38.2).
 *
 * A batch rather than a single string, because embedding a page of articles is one call for
 * a provider and a page of calls for a naive caller. A provider without a batch API
 * implements this as a loop; a caller with one string passes an array of one.
 *
 * Throwing is how unavailability is reported. §38.2 leaves search lexical when this fails,
 * which is a different outcome from an empty array — and an empty array is never a valid
 * answer to a non-empty input.
 */
export interface Embedder {
  /** Recorded with every vector, so a stale one can be found after a model change. */
  name: string;
  /** What the index was created with. A mismatch is a deployment error, not a bad query. */
  dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface VectorEntry {
  articleId: OratorId;
  vector: number[];
}

export interface VectorMatch {
  articleId: OratorId;
  /** Cosine similarity, −1 to 1. Used for ordering and for a floor, never shown to a reader. */
  score: number;
}

/**
 * The vector store (SPEC §38.2).
 *
 * Deliberately not a repository, for the reason §38.1 gives about the FTS index: it is
 * derived, rebuildable, and updated outside the write transaction so that a slow or failing
 * store cannot lengthen the critical path of publishing. Nothing here returns a
 * `PendingWrite`, because none of it is transactional with anything.
 *
 * Three methods and not four. `nearestTo(articleId)` — nearest to an article already in the
 * index, for a related-articles list costing no inference call — was designed, measured and
 * dropped: ADR 0012 has the numbers, and the short version is that article-to-article cosine
 * on this corpus separates a real relation from noise by 0.07, which is not a threshold. A
 * port method with no consumer is an abstraction waiting to be filled in by whoever needs
 * something vaguely like it (§26.13), so it is absent rather than unused.
 *
 * Every method may throw. §38.2's degradation is the caller's business, not the adapter's.
 */
export interface VectorIndex {
  upsert(entries: readonly VectorEntry[]): Promise<void>;
  remove(articleIds: readonly string[]): Promise<void>;
  /** Nearest to a vector the caller holds — the search path, after embedding the query. */
  nearest(vector: readonly number[], limit: number): Promise<VectorMatch[]>;
}

export interface EmbeddingRecord {
  /**
   * The sha256 of the text that was given to the model — title, excerpt and body window —
   * and deliberately not the body's `content_hash`.
   *
   * A title-only edit produces a new revision carrying the same `content_hash` (§16.2), so a
   * ledger keyed on the body would answer "already done" and leave the old title inside the
   * vector. The FTS index had exactly that bug from Phase 4 until ADR 0012.
   */
  inputHash: string;
  /**
   * The revision the vector was made from (migration 0023).
   *
   * Not part of the decision to spend an inference call — `inputHash` is. It exists so the
   * backlog drain can ask "has this moved?" in SQL, which it cannot do with a hash it has no
   * way to recompute. Null for a row written before 0023, which reads as stale.
   */
  revisionId: string | null;
  model: string;
  dimensions: number;
}

/**
 * What has been embedded (SPEC §38.2, migration 0022).
 *
 * In D1 and therefore a repository, unlike the two above. It holds no vector — §38.2 forbids
 * one reaching D1 — only the answer to "has this article, as published right now, been read
 * by this model".
 */
export interface EmbeddingLedger {
  find(articleId: string): Promise<EmbeddingRecord | null>;
  record(entry: EmbeddingRecord & { articleId: string; embeddedAt: string }): PendingWrite;
  /** For an article that has become a duplicate, or has stopped being published. */
  forget(articleId: string): PendingWrite;
  /**
   * Published articles with no current vector, oldest first (SPEC §35.2).
   *
   * The backlog drain's whole query, and the reason there is no backfill script. "No current
   * vector" is three cases and one predicate: never embedded, embedded from a revision that is
   * no longer the published one, or embedded by a model that is no longer in use. Duplicates
   * are excluded here rather than by the caller, because the caller would have to read every
   * candidate to find out.
   *
   * The second of the three was claimed by 0022 and implemented by 0023: the predicate checked
   * only the first and third, so a lost `article.updated` event left a vector stale for good.
   */
  listStale(model: string, limit: number): Promise<OratorId[]>;
  /** How deep the backlog is, for §66.4's report. Bounded by a cap, not a full count. */
  countStale(model: string, cap: number): Promise<number>;
}
