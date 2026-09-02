import { redactMachineAddressed } from "../moderation/heuristics.js";
import { sha256Hex } from "../text/digest.js";
import { stripInvisible } from "../text/invisible.js";
import type { Embedder, VectorIndex } from "../ports/index.js";
import type { Ports } from "./context.js";

/**
 * The two things a deployment may not have (SPEC §38.2).
 *
 * Passed in rather than put on `Ports`, and grouped rather than passed separately, because
 * they are absent together and useless apart: a model with nowhere to put a vector and a
 * store with nothing to put in it are both "this deployment has no semantic search". The
 * ledger is on `Ports` instead — it is D1, it is always there, and it is what lets a
 * deployment that gains the bindings later find out how far behind it is.
 *
 * The same shape the classifier takes (§22.3): the caller holds the binding and decides
 * whether there is a provider at all, so a missing binding is a deployment state rather than
 * an error, exactly as `wrangler.jsonc` describes for Workers AI.
 */
export interface SemanticProvider {
  embedder: Embedder;
  vectors: VectorIndex;
}

/**
 * Embedding published articles (SPEC §38.2, §38.3, ADR 0012).
 *
 * The write half of semantic search. It runs where classification runs — on the article
 * event, after the commit, never in front of it — for the reason §38.1 gives about the FTS
 * index and §22.3 gives about the classifier: a model on the publishing path turns a
 * provider having a bad minute into a platform that accepts no writes.
 *
 * Everything here is spending decisions. An embedding call is the only per-article cost on
 * the platform that a redelivery could repeat indefinitely, so three separate things stop it
 * from being spent twice, and each answers a different question:
 *
 *   1. is this article one whose vector could ever be returned?   (published, and no duplicate)
 *   2. has this exact text already been read by this model?       (the ledger's input hash)
 *   3. was the answer to 2 produced by the model in use now?      (the ledger's model)
 */

/**
 * How much of an article is embedded.
 *
 * The same window the classifier reads (§22.3), and the same argument: what an article is
 * about is established early and does not change on page nine. bge-m3 accepts 8 192 tokens,
 * so this sits comfortably inside the context rather than relying on the provider to
 * truncate — a provider that truncates silently and a caller that assumes it did not are how
 * two deployments of the same corpus end up with different vectors.
 */
export const MAX_EMBEDDED_BODY_CHARS = 8_000;

export type EmbeddingStatus =
  /** A vector was written and the ledger updated. */
  | "embedded"
  /** Already embedded, from these exact bytes, by this model. A redelivery, and a no-op. */
  | "unchanged"
  /** The article's vector was removed: it is a duplicate, unpublished, private or gone. */
  | "removed"
  /** The provider or the store failed. Search stays lexical; nothing is recorded. */
  | "unavailable"
  /** Not an article this applies to: a draft, a tombstone, a missing body. */
  | "skipped";

/**
 * The text a vector is made from.
 *
 * Title first, because the pooling is `cls` and the opening tokens carry disproportionate
 * weight — which is the behaviour wanted, since a title is the densest sentence an article
 * has. Then the excerpt, which is the author's own summary, then the body window.
 *
 * Sanitised exactly as the classifier's input is (§22.3, §58.1), and the reasoning transfers
 * with one substitution. Invisible characters go because the renderer strips them on the way
 * out and this path does not go through the renderer, so a payload has to be visible to a
 * human reading the article. Sentences addressed to a machine go because they are how an
 * article argues about its own placement — for the classifier that meant the wrong topic; for
 * an embedding it means an article that ranks for a query it has nothing to do with, which is
 * keyword stuffing with better grammar. Neither is a defence on its own; both are cheap.
 */
export function embeddableText(input: {
  title: string;
  excerpt: string | null;
  body: string;
}): string {
  const clean = (text: string) => redactMachineAddressed(stripInvisible(text));
  return [
    clean(input.title),
    input.excerpt === null ? "" : clean(input.excerpt),
    clean(input.body).slice(0, MAX_EMBEDDED_BODY_CHARS),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * Embeds one article, or removes what should not be in the index.
 *
 * Reads current state rather than trusting the event, like every other handler: at-least-once
 * delivery means the message may be a replay, and current state is the only thing that is
 * true twice (§35.3).
 */
export async function embedArticle(
  ports: Ports,
  articleId: string,
  semantic: SemanticProvider,
): Promise<EmbeddingStatus> {
  const { embedder, vectors } = semantic;
  const article = await ports.articles.findById(articleId);

  /*
   * The removal path, which is most of the interesting cases.
   *
   * An article leaves the index for four different reasons and they arrive by three
   * different routes — unpublished by its author, made private, removed by moderation, or
   * found to be a byte-identical duplicate of somebody else's (§60.1). Handled together
   * because the consequence is the same and because getting it wrong is invisible: a vector
   * left behind for a withdrawn article is returned by a semantic query, is then dropped
   * when `search` rehydrates it and finds nothing, and shows up as a search that quietly
   * returns four results when it found five.
   *
   * The duplicate case is the one that saves money rather than correctness. §38.1's search
   * already refuses to return a duplicate, so its vector could never surface; embedding it
   * would spend an inference call on a row that is filtered at read time. It is checked
   * *after* §50.3's evaluation on the same event, because that is what writes `duplicate_of`.
   */
  const live =
    article !== null &&
    article.status === "published" &&
    article.visibility === "public" &&
    (article.duplicateOf === null || article.duplicateOf === undefined)
      ? article
      : null;
  const publishedRevisionId = live?.publishedRevisionId ?? null;

  if (live === null || publishedRevisionId === null) {
    // Nothing held means nothing to withdraw. Checked before the store is touched, so the
    // ordinary case — a draft, or an event about an article that was never indexed — costs
    // one indexed read rather than a round trip to Vectorize.
    if ((await ports.embeddings.find(articleId)) === null) return "skipped";
    try {
      await vectors.remove([articleId]);
    } catch (error) {
      // Not fatal and not retried. The ledger row stays, so the backlog drain does not
      // immediately re-embed; the stale vector is dropped at read time by `search`, and the
      // next event tries the removal again.
      log("error", "embedding.remove.unavailable", articleId, { error: String(error) });
      return "unavailable";
    }
    await ports.db.commit([ports.embeddings.forget(articleId)]);
    return "removed";
  }

  const revision = await ports.articles.findRevision(publishedRevisionId);
  if (revision === null) return "skipped";

  const stored = await ports.content.get(revision.contentHash);
  if (stored === null) return "skipped";

  const text = embeddableText({
    title: revision.title,
    excerpt: revision.excerpt,
    body: stored,
  });
  const inputHash = await sha256Hex(text);

  /*
   * The three-part idempotency check, in one comparison.
   *
   * The model belongs in it as much as the hash does. Changing the embedder invalidates every
   * vector in the store — a query embedded by one model against a corpus embedded by another
   * returns plausible nonsense rather than an error, which is the worst failure mode
   * available here — so a ledger row naming the previous model is as stale as one naming
   * different bytes, and is treated identically. That is also what makes a model change a
   * configuration change rather than a migration: the backlog drain finds every row that
   * names the old name.
   */
  const held = await ports.embeddings.find(articleId);
  const sameText = held !== null && held.inputHash === inputHash && held.model === embedder.name;

  if (sameText && held.revisionId === publishedRevisionId) return "unchanged";

  if (sameText) {
    /*
     * The revision moved and the text the model reads did not (migration 0023).
     *
     * Two ways to get here. A body edit past the 8 000-character window produces a new
     * revision whose first 8 000 characters are identical — re-embedding would buy a vector
     * bit-for-bit equal to the one already stored. And every row written before 0023 recorded
     * no revision at all, so the drain hands each of them over exactly once.
     *
     * The ledger is written and the model is not called, which is the whole point: without
     * this branch the drain would select those rows on every run for ever, paying an R2 read
     * each time to reach the same conclusion. A safety net that cannot mark a thing as caught
     * keeps catching it.
     */
    await ports.db.commit([
      ports.embeddings.record({
        articleId,
        inputHash,
        revisionId: publishedRevisionId,
        model: embedder.name,
        dimensions: embedder.dimensions,
        embeddedAt: ports.clock.now().toISOString(),
      }),
    ]);
    return "unchanged";
  }

  let vector: number[] | undefined;
  try {
    [vector] = await embedder.embed([text]);
  } catch (error) {
    /*
     * §38.2 — an unavailable embedder leaves search lexical.
     *
     * The same degradation §22.3 chose for classification and §61 for screening. Nothing is
     * recorded, so the next event — or the backlog drain, which does not need one — tries
     * again. Not a queue failure: retrying the message would re-index and re-screen for no
     * reason.
     */
    log("error", "embedding.provider.unavailable", articleId, {
      provider: embedder.name,
      error: String(error),
    });
    return "unavailable";
  }

  if (vector === undefined || vector.length !== embedder.dimensions) {
    /*
     * A dimension mismatch is a deployment error, not a bad article.
     *
     * The store would reject it, but only after the inference call has been paid for and
     * with a message about a vector rather than about a configuration. Named here, once,
     * loudly, because the shape of the failure it produces otherwise — every article failing
     * identically and permanently — reads like an outage.
     */
    log("error", "embedding.dimensions.mismatch", articleId, {
      provider: embedder.name,
      expected: embedder.dimensions,
      received: vector?.length ?? 0,
    });
    return "unavailable";
  }

  /*
   * The store first, the ledger second, and the order is the whole of the crash safety.
   *
   * A crash between them re-embeds this article on the next event or cron run, which costs
   * one call. The reverse order would record "done" for a vector that never arrived, and
   * nothing would ever look at that article again — the failure that is silent, permanent,
   * and invisible to every check the platform has.
   */
  try {
    await vectors.upsert([{ articleId: live.id, vector }]);
  } catch (error) {
    log("error", "embedding.store.unavailable", articleId, { error: String(error) });
    return "unavailable";
  }

  await ports.db.commit([
    ports.embeddings.record({
      articleId,
      inputHash,
      revisionId: publishedRevisionId,
      model: embedder.name,
      dimensions: embedder.dimensions,
      embeddedAt: ports.clock.now().toISOString(),
    }),
  ]);

  return "embedded";
}

/**
 * How many articles one cron run embeds.
 *
 * Small on purpose. The drain is a safety net (§35.2), not a batch job: it shares a five
 * minute cron with the sitemap rebuild and a Worker's CPU budget with it, and a corpus that
 * needs a thousand embeddings gets them over an afternoon rather than in one invocation that
 * times out halfway and leaves nobody able to say how far it got.
 */
export const EMBEDDING_BATCH = 10;

/**
 * How much of the corpus one cron run looks at.
 *
 * The drain used to ask for stale articles directly, which reads until it has found ten of
 * them — and on a corpus with none left, that is every article, every five minutes, for ever.
 * It was 155k rows in six hours of D1 analytics against 1 127 articles, two thirds of
 * everything the database did, to return nothing on all but a handful of runs.
 *
 * So the run reads a window instead and remembers where it stopped. The cost of a run is now
 * the window rather than the corpus, and it stays the window when the corpus is fifty times
 * larger — which is the property the drain was written to have and did not.
 *
 * What it costs is detection time: a lost event is caught within a full sweep rather than
 * within five minutes. At this size that is half an hour. It buys nothing to make it shorter,
 * because the event path is what makes embedding prompt (§35.2) and this is what catches the
 * event path failing.
 *
 * Twenty windows to a batch, deliberately. A model change makes every article in the window
 * stale, so the run still finds its ten without reading further, and re-embedding the corpus
 * after a configuration change goes at exactly the speed it did before.
 */
export const EMBEDDING_WINDOW = 200;

/** Where the sweep stopped, in `retention_cursors` (migration 0025). */
const EMBEDDING_SWEEP = "embedding";

export interface DrainOutcome {
  embedded: number;
  failed: number;
  /** What is still waiting, capped. Zero means the corpus is fully embedded. */
  remaining: number;
}

/**
 * Embeds whatever has no current vector (SPEC §35.2, ADR 0012).
 *
 * This is why there is no backfill script. Three different problems have the same shape and
 * one answer: the corpus published before semantic search existed, an article whose event was
 * lost to a queue failure, and every article at once after the model is changed. A script
 * would have solved the first, been forgotten for the second, and been rewritten for the
 * third.
 *
 * Stops at the first unavailability rather than working through the batch. A provider that is
 * down is down for all ten, and ten failed calls a run is a bill for nothing.
 *
 * A sweep, not a scan (migration 0027). Each run reads one window of the corpus from where the
 * last one stopped, and the position is a cursor in `retention_cursors` — the table 0025 built
 * for exactly this and named after the first thing that needed it. Reaching the end drops the
 * row, which is that table's way of saying "start from the beginning", so the sweep wraps
 * without a special case.
 */
export async function drainEmbeddingBacklog(
  ports: Ports,
  semantic: SemanticProvider,
  limit = EMBEDDING_BATCH,
  window = EMBEDDING_WINDOW,
): Promise<DrainOutcome> {
  const from = (await ports.retentionCursors.read(EMBEDDING_SWEEP)) ?? "";
  const scanned = await ports.embeddings.scanForStale(semantic.embedder.name, from, window);
  const stale = scanned.filter((row) => row.stale).map((row) => row.id);
  const taking = stale.slice(0, limit);

  let embedded = 0;
  let failed = 0;
  /** Articles this run took out of the backlog: written, found unchanged, or withdrawn. */
  let resolved = 0;
  let stalled = false;

  for (const articleId of taking) {
    const status = await embedArticle(ports, articleId, semantic);
    if (status === "unavailable") {
      failed += 1;
      stalled = true;
      break;
    }
    if (status === "embedded") embedded += 1;
    // "skipped" is a revision or a body that could not be read, and leaves the article
    // exactly as stale as it was; everything else means the predicate no longer selects it.
    if (status !== "skipped") resolved += 1;
  }

  /*
   * Where the next run starts, in four situations that are one sentence: the cursor is the
   * furthest point the sweep has actually dealt with.
   *
   * An unavailable provider has dealt with nothing, so the position does not move — advancing
   * past a window full of work nobody did would hand those articles back a full lap later.
   * More stale articles than one batch stops at the last one taken, so the rest are the first
   * thing the next run sees. A window that came back short is the end of the corpus, and the
   * sweep starts over. Otherwise the window was dealt with and the cursor goes to its end.
   *
   * Written on every run, including the ones that moved nothing. The row's `updated_at` is
   * then "when the sweep last ran", which is the only cheap way to see that it is still going
   * round — §66.4's `embedding_sweep` indicator reads exactly this row. That is also why the
   * end of a lap writes an empty position rather than dropping the row the way the content
   * sweep does (0025): here the row's absence would mean two things, and the one it would be
   * taken for is the healthy one.
   */
  const next = stalled
    ? from
    : stale.length > taking.length
      ? (taking.at(-1) ?? from)
      : scanned.length < window
        ? ""
        : (scanned.at(-1)?.id ?? "");
  await ports.db.commit([
    ports.retentionCursors.write(EMBEDDING_SWEEP, next, ports.clock.now().toISOString()),
  ]);

  return {
    embedded,
    failed,
    /*
     * Counted over the whole corpus only when this window was full of work (migration 0027).
     *
     * `countStale` is the one query left here that reads everything, and it used to run on
     * every drain — a fully embedded corpus paid for the scan twice every five minutes to
     * print a zero. What the sweep saw is the honest answer the rest of the time: the window
     * held this many stale articles and this run resolved that many of them. A window that
     * filled its batch is the only case that can be hiding a backlog worth a real number, and
     * that case is about to spend ten inference calls, next to which one scan is nothing.
     */
    remaining:
      stale.length > taking.length
        ? await ports.embeddings.countStale(semantic.embedder.name, 1_000)
        : stale.length - resolved,
  };
}

function log(level: "error" | "warn", event: string, articleId: string, extra: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, article_id: articleId, ...extra });
  if (level === "error") console.error(line);
  else console.warn(line);
}
