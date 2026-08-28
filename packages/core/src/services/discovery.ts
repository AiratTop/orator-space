import { ErrorType, isOratorId, type FeedCursor, type OratorId } from "@orator/protocol";
import { stripInvisible } from "../text/invisible.js";
import type { ArticleCard, ArticleView, FeedPage, SearchDocument, SearchIndex } from "../ports/index.js";
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
export type SearchPorts = ReadingPorts & { search: Pick<SearchIndex, "query"> };

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

  const indexed = await ports.search.indexedHash(articleId);
  if (indexed === view.revision.contentHash) return "unchanged";

  const body = await ports.content.get(view.revision.contentHash);
  const document: SearchDocument = {
    articleId: view.article.id,
    title: view.revision.title,
    excerpt: view.revision.excerpt ?? "",
    body: body === null ? "" : truncateForIndex(body),
    author: view.author.username,
    topics: "",
    contentHash: view.revision.contentHash,
  };

  await ports.search.index(document, new Date().toISOString());
  return "indexed";
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
 * Full-text search over published articles.
 *
 * Returns one ranked page and no cursor. Ranked results cannot be keyset-paginated the way
 * §44.2 requires — the ordering is a score over an index that changes underneath the
 * reader, so page two of a relevance ranking is not a well-defined thing to ask for. An
 * agent that needs more asks for a larger `limit` or a narrower query, which is the honest
 * interface. Deep paging belongs with the vector store (§38.2), not with FTS.
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

  const ids = await ports.search.query(query, pageSize(options.limit));
  if (ids.length === 0) return ok({ query, articles: [] });

  // Rehydrated one at a time rather than through a single `IN (…)`, because D1 caps a
  // statement at 100 bound parameters (ADR 0001) and a page is bounded well under that.
  const cards: ArticleCard[] = [];
  for (const id of ids) {
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
