import { negotiateRepresentation } from "@orator/protocol";
import { CACHE } from "./http.js";

/**
 * The edge cache for pages this Worker generates (SPEC §33.1).
 *
 * §33 assumed that setting `Cache-Control: public, s-maxage=60` would put an article page
 * in Cloudflare's cache. It does not. A response a Worker composes itself never enters the
 * edge cache on the strength of a header — not `Cache-Control`, and not the targeted
 * `Cloudflare-CDN-Cache-Control` either, both of which were tried on staging and left
 * `cf-cache-status` absent entirely. The cache sits in front of an *origin*; a Worker is
 * not one, and there is no origin behind it to cache.
 *
 * The Cache API is the mechanism that does work, and it has to be called deliberately.
 * That is not a workaround — it is the same decision as §14.1's canonical-host redirect:
 * the alternative is a Cache Rule configured in a dashboard, invisible to version control
 * and absent from anyone else's deployment (§82).
 *
 * What this buys is the whole of §33.1. Correctness there comes from a short `s-maxage`
 * plus revalidation, which only costs nothing if the second reader of an article is served
 * without touching D1 at all. Without this the strategy still produces correct pages, at
 * one database query each, forever.
 */

/**
 * The cache key is the URL alone.
 *
 * Deliberately not the incoming `Request`: it carries `If-None-Match`, `Accept-Encoding`
 * and whatever else the client chose to send, and a key that varies with them fragments
 * one document into many entries — the same trap §33.5 avoids with `Vary: Accept`.
 * Conditional requests are answered from the stored response below instead.
 */
const keyFor = (url: string): Request => new Request(url, { method: "GET" });

const isCredentialed = (request: Request): boolean =>
  request.headers.get("authorization") !== null || request.headers.get("cookie") !== null;

/**
 * The one path whose response depends on a request header (SPEC §33.5, §48).
 *
 * An article page answers `Accept: text/markdown` with a redirect to `/p/{id}.md`. A cache
 * keyed on the URL alone cannot represent that, and answering such a request from the
 * stored HTML would silently break content negotiation — which is what happened the first
 * time this cache was deployed.
 *
 * The fix is to leave that request alone rather than to add `Accept` to the key. Putting it
 * in the key is the `Vary: Accept` trap §33.5 exists to avoid; skipping the cache costs one
 * uncached redirect, and the redirect carries `no-store` anyway.
 *
 * `[^/.]+` excludes the id segment of `/p/{id}.md`, so the machine variants stay cacheable
 * even when a client asks for them by name.
 */
const ARTICLE_PAGE = /^\/p\/[^/.]+(\/[^/]*)?$/;

const negotiatesElsewhere = (request: Request): boolean =>
  ARTICLE_PAGE.test(new URL(request.url).pathname) &&
  negotiateRepresentation(request.headers.get("accept")) !== "html";

/** Only an anonymous GET of something the response itself marked public (§33.2). */
export const mayCache = (request: Request, response: Response): boolean =>
  request.method === "GET" &&
  response.status === 200 &&
  !isCredentialed(request) &&
  (response.headers.get("cache-control") ?? "").includes("public");

const sameEntity = (a: string, b: string): boolean =>
  a.replace(/^W\//, "") === b.replace(/^W\//, "");

/**
 * Answers from the edge cache, or returns null to mean "render it".
 *
 * A stored response can still answer a conditional request without sending a body, so the
 * revalidation path stays cheap even on a hit — which is what §33.1 is counting on when it
 * chooses a 60-second `s-maxage` over a longer one.
 */
/**
 * Cloudflare's per-colo cache, named once.
 *
 * `caches.default` is a Workers extension and is absent from the DOM's `CacheStorage`, which
 * is the lib `astro check` compiles this app against. Reaching for it through one narrowing
 * here rather than at each call site keeps the assertion in a place with a comment on it.
 */
const edgeCache = (caches as unknown as { default: Cache }).default;

export async function fromEdgeCache(request: Request): Promise<Response | null> {
  if (request.method !== "GET" || isCredentialed(request)) return null;
  if (negotiatesElsewhere(request)) return null;

  const hit = await edgeCache.match(keyFor(request.url));
  if (hit === undefined) return null;

  const etag = hit.headers.get("etag");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (etag !== null && ifNoneMatch !== null) {
    const matches = ifNoneMatch
      .split(",")
      .map((value) => value.trim())
      .some((value) => value === "*" || sameEntity(value, etag));
    if (matches) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "cache-control": hit.headers.get("cache-control") ?? CACHE.article,
          ...(hit.headers.get("last-modified") === null
            ? {}
            : { "last-modified": hit.headers.get("last-modified")! }),
          "x-orator-cache": "hit",
        },
      });
    }
  }

  const response = new Response(hit.body, hit);
  response.headers.set("x-orator-cache", "hit");
  return response;
}

/**
 * Stores a response for the next reader.
 *
 * Failures are swallowed on purpose. §33.1 makes the cache an accelerator and revalidation
 * the guarantee of correctness, so a page that could not be stored is slower and not
 * wrong — and a `cache.put` that throws must never turn a good page into a 500.
 */
export function toEdgeCache(context: ExecutionContext, request: Request, response: Response): void {
  const stored = new Response(response.clone().body, response);
  stored.headers.set("cache-control", freshnessOnly(response.headers.get("cache-control")));
  stored.headers.delete("x-orator-cache");

  context.waitUntil(
    edgeCache.put(keyFor(request.url), stored).catch(() => {
      // Nothing to do and nothing to report: correctness does not depend on this.
    }),
  );
}

/**
 * Strips `stale-while-revalidate` from what the shared cache is allowed to keep.
 *
 * The directive is right for a browser, which revalidates in the background and holds a
 * page for a session. It is wrong here. Nothing in this Worker revalidates a stale entry,
 * so an honoured `stale-while-revalidate=86400` would let the shared cache serve an
 * article for a day after it stopped being publishable — and unpublishing is supposed to
 * take effect (§23.1), which is a correctness property rather than a latency one.
 *
 * The browser still receives the full policy; only the copy the edge keeps is narrowed to
 * its freshness lifetime. Sixty seconds of staleness is the bound §33.1 chose deliberately.
 */
function freshnessOnly(cacheControl: string | null): string {
  if (cacheControl === null) return CACHE.article;
  return cacheControl
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => !directive.startsWith("stale-while-revalidate"))
    .join(", ");
}
