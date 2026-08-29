import type { Embedder } from "@orator/core/ports";

/**
 * Embeddings over Workers AI (SPEC §38.2, ADR 0012).
 *
 * The model runs in the same account as the classifier and the moderation provider, on a
 * binding rather than over the network with a key — which is what makes it a reasonable
 * implementation of a port that §66.6 forbids an external service from being the only
 * implementation of.
 */

/**
 * A multilingual embedding model, and the multilingual part is the entire argument.
 *
 * `@cf/baai/bge-large-en-v1.5` is the same 1 024 dimensions and would have been the obvious
 * pick. It would also delete the reason ADR 0012 exists: the query class FTS cannot answer is
 * a Russian query against an English article, and an English-only model answers it exactly as
 * badly as FTS does. Measured across the two languages on 2026-08-29 — 0.82 for the same
 * subject, 0.30 for different ones.
 *
 * Verified against the account rather than read off a model card, because §22.3's history in
 * this repository is that a model id is configuration only a real call can check: the
 * unquantised classifier model was not in the catalogue, and the failure was indistinguishable
 * from an outage from outside.
 */
const MODEL = "@cf/baai/bge-m3";

/**
 * What the index was created with, and what a mismatch would cost.
 *
 * Vectorize fixes dimensions at creation and refuses to change them afterwards, so this
 * number and `wrangler vectorize create --dimensions=1024` are one decision written in two
 * places. The service checks a returned vector against it before the store does, so the
 * failure names a configuration rather than a vector.
 */
const DIMENSIONS = 1024;

interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Reads whatever the model produced.
 *
 * `{ text: string[] }` in, `{ data: number[][], shape: [n, 1024], pooling: "cls" }` out —
 * observed, not assumed. Strict about the contents where the classifier's parser is
 * forgiving, and the difference is not inconsistency: a sloppy parse of a classification
 * proposes a slug that the vocabulary check then discards, while a sloppy parse of an
 * embedding produces a shorter array that the store accepts or a wrong one that it does not.
 * There is no downstream check to be forgiving on behalf of.
 */
function parseVectors(raw: unknown, expected: number): number[][] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("embedder returned no data array");
  if (data.length !== expected) {
    throw new Error(`embedder returned ${data.length} vectors for ${expected} inputs`);
  }

  return data.map((vector, index) => {
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
      throw new Error(`embedder returned a non-numeric vector at ${index}`);
    }
    return vector as number[];
  });
}

export function createWorkersAiEmbedder(ai: AiBinding, model = MODEL, dimensions = DIMENSIONS): Embedder {
  return {
    name: `workers-ai:${model}`,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];

      const result = await ai.run(model, {
        text: [...texts],
        /*
         * The model's own truncation, as the second line rather than the first.
         *
         * The service already cuts the body to 8 000 characters, comfortably inside bge-m3's
         * 8 192 token context, so this should never fire. It is set because the alternative
         * when it would have fired is the call throwing — and an article long enough to
         * overflow despite the cut would then be the one article on the platform that could
         * never be embedded, failing identically forever on every cron run.
         */
        truncate_inputs: true,
      });

      /*
       * Not re-normalised. bge-m3 returns unit vectors — measured at 1.0000 — so cosine and
       * dot product already agree, and the Vectorize index is created with `--metric=cosine`
       * either way. Normalising here would be a no-op that quietly hides a model change that
       * stopped returning unit vectors, which is a thing worth noticing rather than papering
       * over.
       */
      return parseVectors(result, texts.length);
    },
  };
}
