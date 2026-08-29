import { ErrorType, isOratorId, type FeedCursor, type OratorId } from "@orator/protocol";
import { sha256Hex } from "../text/digest.js";
import { stripInvisible } from "../text/invisible.js";
import type {
  ArticleCard,
  ArticleView,
  Embedder,
  FeedPage,
  SearchDocument,
  SearchIndex,
  VectorIndex,
} from "../ports/index.js";
import { fail, ok, type Result } from "./context.js";
import { pageSize, withTopics, type ReadingPorts } from "./reading.js";

/**
 * Discovery: the feed, and search (SPEC §37, §38).
 *
 * The feed is a read of the published index and needs nothing else. Search is the
 * interesting half, because it is the first thing in the system that is *derived* — an
 * index that lags the data by one event and is rebuildable from scratch. Everything here
 * treats it that way: results are checked against live article state, and a query that
 * finds nothing is not distinguishable from an article not yet indexed.
 */

/** Reading, plus the index. Narrow on purpose: discovery writes nothing (§28). */
export type DiscoveryPorts = ReadingPorts & { search: SearchIndex };

/**
 * What *querying* needs, which is less than what indexing needs (§28, §49).
 *
 * The public web renders a search page and must not be able to write to the index. Passing
 * it a whole `SearchIndex` would hand a read-only surface `index()` and `remove()` and rely
 * on nobody calling them; narrowing the parameter instead makes the restriction the type
 * system's problem — the web assembles `{ query }` and a write from a page does not
 * compile, which is the same argument `ReadingPorts` makes for the rest of the read path.
 */
export type SearchPorts = ReadingPorts & {
  search: Pick<SearchIndex, "query">;
  /**
   * The semantic leg, absent on a deployment without the bindings (SPEC §38.2).
   *
   * Optional rather than a no-op implementation, because "this deployment has no vector
   * store" and "the vector store returned nothing" are different facts and only one of them
   * is worth logging. Narrowed to `nearest` for the reason `search` is narrowed to `query`:
   * a page that renders untrusted content should not hold the ability to write an index.
   */
  semantic?: { embedder: Embedder; vectors: Pick<VectorIndex, "nearest"> };
};

export async function feed(
  ports: ReadingPorts,
  options: { limit?: number; before?: FeedCursor | null } = {},
): Promise<FeedPage> {
  return ports.reading.listLatest(pageSize(options.limit), {
    before: options.before ?? null,
    after: null,
  });
}

/**
 * The body a search entry is built from (SPEC §38.1).
 *
 * Truncated, because the index shares D1's 10 GB ceiling with the data (§31.3) and an
 * article's opening is where its subject is stated. Invisible characters come out first,
 * for the same reason they come out of every other representation: an index built from
 * hidden text answers queries nobody typed (§58.2).
 */
export const MAX_INDEXED_BODY_BYTES = 20_000;

export function truncateForIndex(markdown: string): string {
  const clean = stripInvisible(markdown);
  if (new TextEncoder().encode(clean).length <= MAX_INDEXED_BODY_BYTES) return clean;

  // Cut on a character boundary, then back off to whitespace so a partial word does not
  // become a term that matches nothing.
  const cut = clean.slice(0, MAX_INDEXED_BODY_BYTES);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > MAX_INDEXED_BODY_BYTES * 0.9 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Brings the index up to date with one article (SPEC §38.1).
 *
 * Called from the event handler, never from a request. Idempotent by construction: it is
 * safe to run on an article that is already indexed, which matters because queue delivery
 * is at-least-once (ADR 0001).
 */
export async function reindexArticle(ports: DiscoveryPorts, articleId: string): Promise<"indexed" | "removed" | "unchanged"> {
  const view = await ports.reading.findPublished(articleId);
  if (view === null) {
    // Not an error. An article that has been withdrawn, removed or made private simply
    // stops being findable, and the handler that told us about it may be a retry.
    await ports.search.remove(articleId);
    return "removed";
  }

  const body = await ports.content.get(view.revision.contentHash);
  const document: Omit<SearchDocument, "inputHash"> = {
    articleId: view.article.id,
    title: view.revision.title,
    excerpt: view.revision.excerpt ?? "",
    body: body === null ? "" : truncateForIndex(body),
    author: view.author.username,
    topics: "",
    contentHash: view.revision.contentHash,
  };

  /*
   * The skip check compares the whole document, not the body it contains (ADR 0012).
   *
   * It compared `revision.contentHash` from Phase 4 until 2026-08-29, and that was wrong in
   * one specific and entirely ordinary case: editing a title creates a new revision carrying
   * the *same* body, so the hashes matched, the entry was skipped, and the index kept
   * answering with the previous title. Nobody saw it because a stale title in an inverted
   * index produces a result that is right about which article and wrong about its name.
   *
   * Found by asking what the embedding ledger should be keyed on, where the same composition
   * of title, excerpt and body had to be hashed for the same reason. Both indexes now key on
   * the text they were actually built from, which is the only hash that answers the question
   * either of them is asking.
   */
  const inputHash = await sha256Hex(
    [document.title, document.excerpt, document.author, document.topics, document.contentHash].join("\u0000"),
  );
  const indexed = await ports.search.indexedHash(articleId);
  if (indexed === inputHash) return "unchanged";

  await ports.search.index({ ...document, inputHash }, new Date().toISOString());
  return "indexed";
}

/**
 * The floor a semantic match has to clear (SPEC §38.2, ADR 0012).
 *
 * Measured, not chosen: on `@cf/baai/bge-m3`, a relevant article sits at 0.45 to 0.63 from a
 * query and an irrelevant one at 0.16 to 0.40. The number that decides it is neither of
 * those — it is what a *vague* query does. "какой-то совершенно посторонний запрос про
 * садоводство" scored 0.38 to 0.40 against every article in the sample, because a long
 * unfocused string sits at a middling distance from everything. Without a floor, the queries
 * that deserve no answer are the ones that match the whole corpus.
 *
 * It sits 0.03 under the weakest true positive measured, and the asymmetry is what makes
 * that acceptable: a semantic match dropped at 0.44 is one FTS almost certainly found,
 * because a query that close shares terms with the article. A noise match admitted at 0.40
 * is a wrong answer on a page that would otherwise have said nothing honestly.
 *
 * To be recalibrated on a real corpus, like §80.4's SimHash distance. A calibration, not an
 * open question.
 */
export const MIN_SIMILARITY = 0.42;

/**
 * How far below the best match a result may sit and still be returned.
 *
 * The same shape `classification.ts` uses on the classifier's output, arrived at
 * independently and for the same reason: a query with one strong answer and a tail of
 * plausible ones is a different distribution from a query genuinely about two things, and
 * the two differ in *shape* rather than in level — which is exactly what an absolute
 * threshold cannot see.
 */
export const MIN_RELATIVE_SIMILARITY = 0.75;

/**
 * How deep each leg is asked to go before fusion.
 *
 * Deeper than the page, because RRF needs an ordering to work with and a leg truncated at
 * the page size has thrown away the ranks that would have moved a result up. Bounded because
 * both legs cost something — an FTS scan and a Vectorize query — and because a result ranked
 * fortieth by both legs is not going to reach the top of anything.
 */
export const FUSION_DEPTH = 40;

/**
 * The constant in Reciprocal Rank Fusion.
 *
 * Sixty, from the original paper, and left alone deliberately. It sets how quickly a result's
 * contribution decays with its rank; the published value is insensitive enough across corpora
 * that tuning it on a corpus of tens of articles would be fitting noise.
 */
const RRF_K = 60;

/**
 * Merges two rankings into one (SPEC §38.2, ADR 0012).
 *
 * Reciprocal Rank Fusion, and the reason it is not a weighted sum of scores is that there are
 * no comparable scores to weight. FTS5's `rank` is a BM25 value — unbounded, negative, and
 * dependent on the corpus's term statistics. A cosine similarity is bounded, positive, and
 * dependent on the query. Any constant chosen to bridge them is fitted to a corpus that is
 * about to change, and the fit fails silently: the ranking stays plausible while being wrong.
 *
 * RRF throws both magnitudes away and keeps only the position each leg assigned. What
 * survives is the property worth having — a result both legs liked beats one that only one
 * leg liked, and a leg that returns nothing contributes nothing rather than contributing
 * zeros. That last part is the degradation in §38.2, obtained for free rather than as a
 * special case.
 */
export function fuse(rankings: readonly (readonly OratorId[])[], limit: number): OratorId[] {
  const scores = new Map<OratorId, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  /*
   * Ties broken by id, descending — which is newest first, because §12 makes the id monotonic
   * in creation time.
   *
   * Two things at once, and the second is why it is descending rather than any fixed rule.
   * A tie has to break *somewhere*, and an unstable break means the same query returns its
   * results in a different order on a second request, which is a bug report nobody can
   * reproduce. Given that it must break somewhere, the newer of two equally relevant articles
   * is the better answer, and it is the order the feed already uses.
   */
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * The semantic leg: embed the query, ask the store, apply the two floors.
 *
 * Returns an empty ranking for every kind of failure, which is what makes §38.2's degradation
 * total: a deployment with no bindings, a model having a bad minute and a store that is
 * unreachable all leave search lexical, and none of them reaches the caller as an error. The
 * three are distinguished in the log and nowhere else, because a reader searching for
 * something does not need to know which half of the platform is unwell.
 */
async function semanticRanking(
  ports: SearchPorts,
  query: string,
  limit: number,
): Promise<OratorId[]> {
  const semantic = ports.semantic;
  if (semantic === undefined) return [];

  try {
    const [vector] = await semantic.embedder.embed([query]);
    if (vector === undefined) return [];

    const matches = await semantic.vectors.nearest(vector, limit);
    const best = matches[0]?.score ?? 0;
    const floor = Math.max(MIN_SIMILARITY, best * MIN_RELATIVE_SIMILARITY);
    return matches.filter((match) => match.score >= floor).map((match) => match.articleId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "search.semantic.unavailable",
        provider: semantic.embedder.name,
        error: String(error),
      }),
    );
    return [];
  }
}

export interface SearchResults {
  query: string;
  articles: ArticleCard[];
}

/**
 * A result, from the article it names.
 *
 * Shared by the two paths below so a card found by id and a card found by a term are the
 * same object. §66.7's exclusion is here rather than at each call site for the same reason.
 */
function cardFor(view: ArticleView): ArticleCard | null {
  /*
   * §66.7 — the canary is in the index and not in the results.
   *
   * It has to be in the index: the deep check waits for it to appear there, and that wait is
   * the one thing in the check that requires the queue, the consumer and the index to all be
   * alive. It must not be in the results: a search result is somewhere a reader arrives
   * without asking, and the platform's own heartbeat is not an answer to anybody's query.
   */
  if (view.author.systemAccount) return null;

  return {
    id: view.article.id,
    title: view.revision.title,
    excerpt: view.revision.excerpt,
    language: view.article.language,
    authorshipDisclosure: view.article.authorshipDisclosure,
    publishedAt: view.article.publishedAt ?? view.revision.createdAt,
    readingTimeSeconds: view.revision.readingTimeSeconds,
    contentHash: view.revision.contentHash,
    signed: view.revision.signature !== null,
    author: view.author,
    conversation: view.signals,
  };
}

/**
 * Hybrid search over published articles (SPEC §38.1, §38.2, ADR 0012).
 *
 * Two rankings fused: FTS5 over the inverted index, and cosine over the vector store. They
 * are not competing implementations of the same idea — each answers a class of query the
 * other cannot. FTS finds an exact term, a proper noun, an error message pasted from a log.
 * The vector leg finds an article whose subject matches a question phrased differently, or
 * phrased in another language: §24 makes an article carry a language and a Russian query
 * shares no token at all with an English article, so FTS scores that pair at exactly zero,
 * whatever it is about.
 *
 * Returns one ranked page and no cursor. Version 2.8 expected the vector store to bring deep
 * paging with it; the opposite happened, and ADR 0012 says why — a fused ranking is a score
 * over *two* indexes that change underneath the reader, which is less keyset-paginable than
 * one, not more. An agent that needs more asks for a larger `limit` or a narrower query.
 *
 * **An Article ID is answered without touching the index.** Pasting one into a search box is
 * what somebody does with an id they found in a citation, a log or somebody else's article,
 * and §13 makes that id the whole address — so it is an exact lookup rather than a term, and
 * indexing it would be storing an address in an inverted index to get back an approximation
 * of a primary key. It also means an id resolves for an article the index has not reached
 * yet: §34.4 states that a new article is readable at once and searchable shortly after, and
 * this path is the "at once" half.
 */
export async function search(
  ports: SearchPorts,
  text: string,
  options: { limit?: number } = {},
): Promise<Result<SearchResults>> {
  const query = text.trim();
  if (query.length === 0) return fail(ErrorType.ValidationFailed, "A search needs a query");

  /*
   * Uppercased before the test, because an id is often arriving from somewhere that
   * lowercased it — a log line, a shell, a URL somebody's tooling normalised. Crockford
   * base32 is written in upper case and the stored value is, so the comparison is exact and
   * only the reader's copy is forgiven.
   */
  const asId = query.toUpperCase();
  if (isOratorId(asId)) {
    const view = await ports.reading.findPublished(asId);
    // Absent, a draft, removed, or the canary: all indistinguishable from "no match", which
    // is what keeps this from being a yes/no oracle over unpublished work (§43.3).
    const card = view === null ? null : cardFor(view);
    if (card === null) return ok({ query, articles: [] });
    return ok({
      query,
      articles: (await withTopics(ports, { cards: [card], next: null, previous: null })).cards,
    });
  }

  const size = pageSize(options.limit);

  /*
   * Both legs at once (SPEC §38.2, ADR 0012).
   *
   * Concurrently rather than in sequence, because the semantic leg is an inference call plus
   * a vector query and the lexical leg is an index scan — run one after the other, a reader
   * waits for the sum of a fast thing and a slow one. Run together, they wait for the slow
   * one, which is the honest cost of the feature.
   *
   * `semanticRanking` never rejects. §38.2's degradation is total by construction: no
   * bindings, an unavailable model and an unreachable store all produce an empty ranking,
   * and RRF over one non-empty ranking is that ranking. So a deployment without a vector
   * store behaves exactly as it did before this existed, with no branch here saying so.
   */
  const [lexical, semantic] = await Promise.all([
    ports.search.query(query, FUSION_DEPTH),
    semanticRanking(ports, query, FUSION_DEPTH),
  ]);

  const ids = fuse([lexical, semantic], FUSION_DEPTH);
  if (ids.length === 0) return ok({ query, articles: [] });

  // Rehydrated one at a time rather than through a single `IN (…)`, because D1 caps a
  // statement at 100 bound parameters (ADR 0001) and a page is bounded well under that.
  //
  // Stops at a full page rather than rehydrating everything fused. The legs are asked for
  // more than a page precisely so that the filters below — a withdrawn article, a duplicate,
  // the canary — have something to eat into, and reading forty articles to render twenty
  // would spend the whole saving.
  const cards: ArticleCard[] = [];
  for (const id of ids) {
    if (cards.length >= size) break;
    const view = await ports.reading.findPublished(id);
    if (view === null) continue;
    /*
     * §60.1, §13.1 — a search result is a surface the platform curates.
     *
     * Filtered here rather than in the index because the index is rebuilt from articles and
     * a duplicate's text is still the text somebody searched for; what should not happen is
     * the platform offering the same article twice under two titles. The article stays
     * reachable by its own id, which is the search this one still answers.
     */
    if (view.article.duplicateOf !== null && view.article.duplicateOf !== undefined) continue;
    const card = cardFor(view);
    if (card !== null) cards.push(card);
  }

  return ok({ query, articles: (await withTopics(ports, { cards, next: null, previous: null })).cards });
}

export async function searchPrincipals(
  ports: ReadingPorts,
  text: string,
): Promise<Result<{ query: string; principals: Awaited<ReturnType<ReadingPorts["reading"]["findPrincipalByUsername"]>>[] }>> {
  const query = text.trim().toLowerCase().replace(/^@/, "");
  if (query.length === 0) return fail(ErrorType.ValidationFailed, "A search needs a query");

  // Exact username only, for now. A prefix scan over `principals` is cheap, but handing
  // out a way to enumerate every account on the network is not something to add without
  // deciding it deliberately (§43.3).
  const principal = await ports.reading.findPrincipalByUsername(query);
  return ok({ query, principals: principal === null ? [] : [principal] });
}

export type { OratorId };
