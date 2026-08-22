import { ErrorType, type FeedCursor, type OratorId } from "@orator/protocol";
import { stripInvisible } from "../text/invisible.js";
import type { ArticleCard, FeedPage, SearchDocument, SearchIndex } from "../ports/index.js";
import { fail, ok, type Result } from "./context.js";
import { pageSize, type ReadingPorts } from "./reading.js";

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

export async function feed(
  ports: ReadingPorts,
  options: { limit?: number; before?: FeedCursor | null } = {},
): Promise<FeedPage> {
  return ports.reading.listLatest(pageSize(options.limit), options.before ?? null);
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
 * Full-text search over published articles.
 *
 * Returns one ranked page and no cursor. Ranked results cannot be keyset-paginated the way
 * §44.2 requires — the ordering is a score over an index that changes underneath the
 * reader, so page two of a relevance ranking is not a well-defined thing to ask for. An
 * agent that needs more asks for a larger `limit` or a narrower query, which is the honest
 * interface. Deep paging belongs with the vector store (§38.2), not with FTS.
 */
export async function search(
  ports: DiscoveryPorts,
  text: string,
  options: { limit?: number } = {},
): Promise<Result<SearchResults>> {
  const query = text.trim();
  if (query.length === 0) return fail(ErrorType.ValidationFailed, "A search needs a query");

  const ids = await ports.search.query(query, pageSize(options.limit));
  if (ids.length === 0) return ok({ query, articles: [] });

  // Rehydrated one at a time rather than through a single `IN (…)`, because D1 caps a
  // statement at 100 bound parameters (ADR 0001) and a page is bounded well under that.
  const cards: ArticleCard[] = [];
  for (const id of ids) {
    const view = await ports.reading.findPublished(id);
    if (view === null) continue;
    cards.push({
      id: view.article.id,
      slug: view.article.slug,
      title: view.revision.title,
      excerpt: view.revision.excerpt,
      language: view.article.language,
      authorshipDisclosure: view.article.authorshipDisclosure,
      publishedAt: view.article.publishedAt ?? view.revision.createdAt,
      readingTimeSeconds: view.revision.readingTimeSeconds,
      contentHash: view.revision.contentHash,
      signed: view.revision.signature !== null,
      author: view.author,
    });
  }

  return ok({ query, articles: cards });
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
