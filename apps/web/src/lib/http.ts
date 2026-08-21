import { CONTENT_TYPES, type Representation } from "@orator/protocol";

/**
 * Cache and conditional-request handling for the public web (SPEC §33).
 *
 * §33.1 puts correctness in revalidation rather than in purging: a short `s-maxage`, an
 * `ETag`, and a great many `If-None-Match` requests that must each be cheap. So the shape
 * of every read route is the same — load the metadata, answer 304 if you can, and only
 * then pay for the body.
 */

/** SPEC §33.2. Not per-route constants: one table, so no page can invent its own policy. */
export const CACHE = {
  article: "public, s-maxage=60, stale-while-revalidate=86400",
  feed: "public, s-maxage=30, stale-while-revalidate=300",
  /** Anything reached with credentials, and anything that failed. */
  private: "private, no-store",
} as const;

export interface Validators {
  etag: string;
  lastModified: string;
}

/** Quotes the hash. An unquoted ETag is not a valid one, and some caches drop it silently. */
export const quoteEtag = (etag: string): string => `"${etag}"`;

/**
 * Answers a conditional request, or returns null to mean "carry on and render".
 *
 * Called before the body is read, which is the entire point: §33.3 promises revalidation
 * costs one indexed D1 query, and it only does if the R2 read happens after this.
 */
export function notModified(request: Request, validators: Validators): Response | null {
  const tag = quoteEtag(validators.etag);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === null) return null;

  // A cache may send several, and a revalidating proxy may weaken ours to `W/"…"`.
  const matches = ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === tag || value === "*");
  if (!matches) return null;

  return new Response(null, {
    status: 304,
    headers: {
      etag: tag,
      "cache-control": CACHE.article,
      "last-modified": new Date(validators.lastModified).toUTCString(),
    },
  });
}

export function cacheHeaders(headers: Headers, policy: string, validators?: Validators): void {
  headers.set("cache-control", policy);
  if (validators === undefined) return;
  headers.set("etag", quoteEtag(validators.etag));
  headers.set("last-modified", new Date(validators.lastModified).toUTCString());
}

/**
 * A machine-readable representation of an article (§48).
 *
 * `X-Robots-Tag: noindex` is not an afterthought. The same article at three URLs is exactly
 * the duplicate-content pattern §50.2 warns about; the HTML page is the one that should be
 * indexed, and the `Link: rel=canonical` header says which that is for anything that reads
 * headers rather than markup.
 */
export function representationResponse(
  body: string,
  representation: Exclude<Representation, "html">,
  options: { validators: Validators; canonicalUrl: string },
): Response {
  const headers = new Headers({
    "content-type": CONTENT_TYPES[representation],
    "x-robots-tag": "noindex",
    link: `<${options.canonicalUrl}>; rel="canonical"`,
  });
  cacheHeaders(headers, CACHE.article, options.validators);
  return new Response(body, { headers });
}

/** SPEC §14.2 — a permanent redirect, because the canonical URL of an article is stable. */
export const permanentRedirect = (to: string): Response =>
  new Response(null, { status: 301, headers: { location: to, "cache-control": CACHE.article } });

/**
 * SPEC §33.5 — `Accept` is the secondary mechanism, and it redirects.
 *
 * 302 rather than 301: the redirect depends on a request header, and a browser that cached
 * it permanently would be stuck sending a reader to the markdown source of every article.
 */
export const negotiatedRedirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to, "cache-control": CACHE.private } });
