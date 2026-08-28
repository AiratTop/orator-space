import { CACHE, CDN_CACHE } from "./http.js";

/**
 * What every feed response has in common (SPEC §33.2, §48, §50.3).
 *
 * One function so three routes cannot disagree about the content type, the cache policy or
 * the robots directive — the class of drift that put a production hostname in staging's CSP
 * and cost an afternoon.
 *
 * **`noindex`, and it is not a contradiction.** A feed exists to be fetched by software, and
 * §50.2 is about the same text appearing at two addresses: the entries here summarise pages
 * that are themselves indexable, so the feed must not compete with them in a result list. It
 * is still crawlable — a `Disallow` would stop a reader's client as well, and the header is
 * the mechanism that removes a URL from an index (§48).
 */
export function feedResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      // The same freshness as the listing it summarises: a feed reader polls far less often
      // than a browser, so nothing is gained by holding it longer than the page.
      "cache-control": CACHE.feed,
      "cloudflare-cdn-cache-control": CDN_CACHE.feed,
      "x-robots-tag": "noindex",
    },
  });
}

/** The one place the address of a feed is spelled, for the routes and for the page head. */
export const feedPaths = {
  site: "/feed.xml",
  topic: (slug: string) => `/t/${slug}/feed.xml`,
  author: (username: string) => `/@${username}/feed.xml`,
} as const;
