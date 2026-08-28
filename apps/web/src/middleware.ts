import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "astro";
import { CACHE, CDN_CACHE } from "./lib/http.js";
import { fromEdgeCache, mayCache, toEdgeCache } from "./lib/edge-cache.js";
import { mediaOrigin } from "./lib/origins.js";

/**
 * Response-wide rules: the canonical host, the security headers, and the one cache rule
 * that must never be left to a route (SPEC §14.1, §33.2, §57.2, §57.3).
 */

/**
 * SPEC §57.2.
 *
 * `script-src 'self'` with no `unsafe-inline` is only affordable because §49.1 committed
 * to server rendering: a page with no inline script has nothing to whitelist, and the one
 * class of bug that matters most on a site full of untrusted content stops being
 * exploitable even if the sanitiser has a hole. That is the trade — no client-side
 * framework, in exchange for a CSP that actually holds.
 *
 * `img-src` includes `data:` because the sanitiser strips data URLs from content (§57.1.4);
 * what remains is our own inline SVG, and the media origin for user images.
 *
 * **The media origin is derived, not written down.** It was a literal, and the literal was
 * production's: staging served an avatar from `media-staging.orator.space` against a policy
 * that only admitted `media.orator.space`, so the browser blocked every uploaded picture on
 * the deployment where uploads are tested. A blocked image renders as nothing, which from the
 * account page is indistinguishable from an upload that did not work. Third time this literal
 * has cost something — `/llms.txt` and `/robots.txt` were the first two (§14.3).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' ${mediaOrigin} data:`,
  `media-src 'self' ${mediaOrigin}`,
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** SPEC §57.3. */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-resource-policy": "same-site",
};

/**
 * SPEC §14.1, §50 — exactly one hostname serves the site; everything else redirects.
 *
 * A Cloudflare Redirect Rule could do this at the edge, and would be marginally cheaper.
 * It is done here instead because a rule configured in the dashboard is invisible to
 * version control and absent from anyone else's deployment (SPEC §82). Duplicate content
 * on a second hostname is precisely the risk §50.2 spends a section on, and it should not
 * depend on a setting nobody can see in the repository.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const canonical = (env as { SITE_HOST?: string }).SITE_HOST;
  const url = new URL(context.request.url);

  if (canonical && canonical !== "localhost" && url.hostname !== canonical) {
    url.hostname = canonical;
    url.port = "";
    return context.redirect(url.toString(), 301);
  }

  /*
   * One address per page, down to the slash (SPEC §13, §33.2, ADR 0010).
   *
   * `/p/{id}/` and `/p/{id}` both served a 200, which is one document at two URLs and two
   * entries in a cache keyed by the URL — the same duplication the slug was removed to stop,
   * arrived at through a character nobody types on purpose.
   *
   * Here rather than through Astro's `trailingSlash: "never"`, which does not redirect: it
   * simply stops the trailing form matching a route, so the answer becomes 404. A link with
   * a stray slash is not a mistake worth a dead end.
   */
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
    return context.redirect(url.toString(), 301);
  }

  /**
   * Caching is off in local development.
   *
   * A cached page would mask an edit, and an hour lost to that is an hour spent doubting
   * the sanitiser rather than the cache. There is no edge in front of a dev server either,
   * so nothing here is being simulated faithfully in the first place.
   */
  const cacheable = (env as { ENVIRONMENT?: string }).ENVIRONMENT !== "local";

  if (cacheable) {
    const hit = await fromEdgeCache(context.request);
    if (hit !== null) return hit;
  }

  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);

  // HSTS only where TLS is actually in force; sending it from localhost would poison the
  // developer's browser for every other project on that hostname.
  if (url.protocol === "https:") {
    response.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }

  /**
   * SPEC §33.2 — the rule that prevents the most common CDN data leak.
   *
   * Enforced here rather than per route, and unconditionally: a response produced for a
   * credentialed request must never be publicly cacheable, whatever the route decided.
   * Leaving this to individual pages means it holds until the day someone adds a page and
   * forgets, and the failure is silent — a signed-in reader's page served to a stranger.
   * The web surface accepts no credentials today, which is exactly when the rule is cheap
   * to establish.
   */
  if (context.request.headers.get("authorization") !== null || context.request.headers.get("cookie") !== null) {
    response.headers.set("cache-control", CACHE.private);
    response.headers.set("cloudflare-cdn-cache-control", CDN_CACHE.private);
    response.headers.delete("etag");
  }

  // Stored after the headers above are applied, so a cache hit carries the same policy and
  // the same security headers as the response that produced it.
  if (cacheable && mayCache(context.request, response)) {
    toEdgeCache((context.locals as { cfContext: ExecutionContext }).cfContext, context.request, response);
    response.headers.set("x-orator-cache", "miss");
  }

  return response;
};
