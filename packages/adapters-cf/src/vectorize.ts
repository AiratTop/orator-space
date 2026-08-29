import type { VectorIndex } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";

/**
 * The vector store, on Vectorize (SPEC §38.2, ADR 0012).
 *
 * Thin on purpose. Everything that decides what goes in — the duplicate check, the input
 * hash, the two similarity floors — is in the services, because an adapter is where the next
 * implementation gets written and each one would otherwise have to remember. What is here is
 * the store's shape and nothing else, which is what makes ADR 0012's claim about
 * reversibility checkable rather than aspirational.
 */

/**
 * How many vectors go in one upsert.
 *
 * Vectorize takes far more than this; the limit exists because the caller does not. Articles
 * arrive one at a time from the queue and ten at a time from the cron drain, so a batch this
 * size is never split in practice and the constant is a bound on a mistake rather than a
 * throughput setting.
 */
const MAX_BATCH = 100;

interface VectorizeBinding {
  upsert(vectors: { id: string; values: number[] }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; returnValues?: boolean; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches: { id: string; score: number }[] }>;
}

export function createVectorIndex(index: VectorizeBinding): VectorIndex {
  return {
    async upsert(entries) {
      /*
       * Upsert rather than insert, and the distinction is the whole idempotency story here.
       *
       * The queue delivers at least once (ADR 0001) and the cron drain can overlap with an
       * event for the same article. `insert` would make the second one an error to handle;
       * `upsert` makes it the same write twice, which is what a handler that reads current
       * state is entitled to assume it can do.
       */
      for (let i = 0; i < entries.length; i += MAX_BATCH) {
        const chunk = entries.slice(i, i + MAX_BATCH);
        await index.upsert(chunk.map((entry) => ({ id: entry.articleId, values: entry.vector })));
      }
    },

    async remove(articleIds) {
      if (articleIds.length === 0) return;
      for (let i = 0; i < articleIds.length; i += MAX_BATCH) {
        await index.deleteByIds([...articleIds.slice(i, i + MAX_BATCH)]);
      }
    },

    async nearest(vector, limit) {
      /*
       * No values and no metadata returned.
       *
       * An id and a score are the whole of what the caller uses: §38.2 keeps the article's
       * state in D1, and `search` re-reads every result there anyway to decide whether it is
       * still published, still not a duplicate and not the canary. Metadata here would be a
       * second copy of facts D1 already holds, which is the copy that goes stale — a vector
       * store carrying `status: published` is a vector store that will one day disagree with
       * the database about whether an article exists.
       */
      /*
       * `returnMetadata` is an enum, not a boolean, and the two neighbouring options are
       * booleans — which is how `false` got written here and shipped.
       *
       * Vectorize answers a boolean with `VECTOR_QUERY_ERROR (code = 40026): Failed to parse
       * the request body as JSON`, at query time only. Nothing catches it earlier: the types
       * are hand-written here (§28.1 keeps Cloudflare types out of the domain), so the
       * compiler agreed, every test passed against a double that accepted anything, and the
       * corpus embedded correctly — 581 vectors written before a single query was tried.
       *
       * The failure was invisible in the product, which is the part worth remembering. §38.2's
       * degradation caught it exactly as specified: search stayed lexical, the reader saw
       * results, and the only evidence was one `search.semantic.unavailable` line. A graceful
       * degradation hides a bug as effectively as it hides an outage, so the checkpoint has to
       * assert the feature works — not merely that search still answers.
       */
      const { matches } = await index.query([...vector], {
        topK: limit,
        returnValues: false,
        returnMetadata: "none",
      });
      return matches.map((match) => ({ articleId: match.id as OratorId, score: match.score }));
    },
  };
}
