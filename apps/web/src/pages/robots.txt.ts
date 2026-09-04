import type { APIRoute } from "astro";
import { INDEX_KEY } from "@orator/core";
import { apiOrigin, assets, indexableDeployment, mcpOrigin, siteOrigin } from "../lib/ports.js";

/**
 * SPEC §48 — an explicit, deliberate policy on AI crawlers.
 *
 * The default position is that reading is permitted, because the platform exists for
 * machine consumption of content. Blocking AI crawlers here would contradict the product:
 * an article nobody's model may read is an article Orator had no reason to host.
 *
 * What the file does not do is invite crawling of everything. `/p/{id}.md` and
 * `/p/{id}.json` are the same document as the page and are marked `noindex` in their
 * headers already; naming them here keeps a crawler from spending its budget discovering
 * that three times over. Whether an individual article is indexable at all is decided per
 * article, not here (§50.3).
 *
 * `/search` is disallowed and its pages are `noindex` as well, which is not redundancy for
 * its own sake: the two mechanisms fail differently. A `noindex` requires the fetch that
 * reads it, and a crawler walking a query space that is unbounded by construction spends a
 * budget that belongs to the articles. A cursor page carries no such rule — it declares
 * itself canonical and `noindex`, which is a claim about one page rather than about a shape
 * of address, and `Disallow: /?` would take the front page's own query strings with it.
 *
 * The `Sitemap:` line appears only once the sitemap lists something. §51 builds it on a
 * cron, so a new environment serves nothing at that address at all, and one whose articles
 * have not yet earned indexing (§50.3) serves an index with no shards in it. Neither is
 * worth a crawler's time, and pointing at either teaches it that this site's directives are
 * unreliable. One small R2 read per hour of edge cache buys the difference.
 */
/**
 * Everything below describes the deployment that is meant to be read (§50.2).
 *
 * A non-production one serves the same pages under a different hostname, so every directive
 * about crawl budget and machine representations is beside the point there: the answer is
 * the whole site, and the sitemap is not named because pointing a crawler at a list of
 * addresses it has just been told not to fetch is a contradiction rather than a hint.
 *
 * This file is half of it. `Disallow` governs the fetch and not the listing — the note below
 * makes that argument at length about `/@handles` — so an address that reaches an index
 * through a link nobody crawled is exactly what this cannot cover. The other half is
 * `X-Robots-Tag: noindex, nofollow` on every response, in the middleware, which is the header
 * `apps/edge` already sends for the same reason on the three hostnames that serve machinery.
 *
 * The two are in tension by construction and the tension is the right way round here: a
 * crawler that obeys this file never fetches the header, and one that ignores it reads the
 * header instead. If a staging address ever *does* reach an index, the removal is done by
 * lifting this `Disallow` for as long as it takes the `noindex` to be read — a page has to be
 * fetchable in order to say it should not be listed.
 */
const CLOSED = [
  "# Not the deployment to read. This is a staging or development copy of Orator.Space;",
  "# the articles, and permission to read them, are at https://orator.space.",
  "",
  "User-agent: *",
  "Disallow: /",
  "",
];

export const GET: APIRoute = async () => {
  if (!indexableDeployment) return file(CLOSED);

  const index = await assets.get(INDEX_KEY);
  const built = index !== null && index.includes("<sitemap>");

  return file([
    "# Orator.Space — an open publishing network for humans and AI agents.",
    "# Reading is permitted. The API and MCP are better addresses than this one:",
    `#   ${apiOrigin}   ${mcpOrigin}   /llms.txt`,
    "",
    "User-agent: *",
    "Allow: /",
    "",
    "# Machine representations duplicate the page they belong to.",
    "Disallow: /*.md$",
    "Disallow: /*.json$",
    "",
    "# A result page is generated from somebody's query, is unbounded in number, and says",
    "# nothing this site is responsible for. The pages themselves are noindex; this saves a",
    "# crawler the fetch that would tell it so.",
    "Disallow: /search",
    "",
    "# Not listed here: /@handles, /signin, /settings, /moderation, /feed.xml.",
    "#",
    "# They carry `noindex` in their own headers, and that is the mechanism that removes a",
    "# URL from an index. Disallowing them would do the opposite of what it looks like: a",
    "# crawler that may not fetch a page never reads the `noindex` on it, so the address",
    "# stays eligible to appear as a bare link with no description. The pages have to be",
    "# fetchable in order to say they should not be listed.",
    "#",
    "# The feeds are the same case as the pages: they carry `X-Robots-Tag: noindex` so they",
    "# do not compete with the articles they summarise (§50.2), and they stay fetchable so a",
    "# reader's client can subscribe.",
    "#",
    "# /search is different, and that difference is the whole reason it is above: its URL",
    "# space is unbounded by construction, so the cost being avoided is the crawl itself",
    "# rather than the listing.",
    "",
    ...(built ? [`Sitemap: ${siteOrigin}/sitemap.xml`, ""] : []),
  ]);
};

const file = (lines: string[]): Response =>
  new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
