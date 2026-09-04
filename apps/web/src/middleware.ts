import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "astro";
import { CACHE, CDN_CACHE } from "./lib/http.js";
import { fromEdgeCache, mayCache, toEdgeCache } from "./lib/edge-cache.js";
import { indexableDeployment, mediaOrigin } from "./lib/origins.js";
import { resolveSession } from "@orator/core";
import { authPorts, readCookie, SESSION_COOKIE } from "./lib/auth.js";
import { principalOf } from "./lib/account.js";

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
  /*
   * §57.3, §9.3 — `self`, plus the one destination a form is allowed to leave for.
   *
   * `form-action` governs where a submission may navigate, redirects included, so the
   * connect button — a POST that answers 303 into the chat — was blocked by this policy with
   * no error anywhere the person could see: the browser simply did nothing. That is the
   * failure mode this directive is for, and the answer is to name the exception rather than
   * to drop the rule or to make the button a link, because a link is a GET and creating a
   * credential is not a safe method.
   *
   * `https://t.me` and nothing else. The address is built from configuration and a nonce
   * this platform issued; no part of it comes from a request.
   */
  "form-action 'self' https://t.me",
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

  /*
   * Who is reading, resolved once (SPEC §49.2, §61.1).
   *
   * Only when a cookie is present, which is what keeps this off the path that matters: an
   * anonymous request is answered from the edge cache above and never reaches here. A
   * signed-in reader pays two indexed reads per page, and the alternative was every page
   * that wants to know resolving the session for itself.
   *
   * The role comes from the principal row rather than from the session, because a role is
   * revoked by editing that row — a copy carried in a cookie would outlive the revocation.
   */
  /*
   * Documents only. A stylesheet does not have a masthead.
   *
   * Every asset a signed-in reader fetches carries the same cookie, so without this the two
   * reads happen for `styles.css`, `theme.js` and the favicon as well — five times the cost
   * for one answer, on the one class of request that is otherwise free. The machine
   * representations of an article (`.md`, `.json`) are excluded for the same reason: nothing
   * in them depends on who is asking.
   */
  const wantsChrome = !/\.[a-z0-9]+$/i.test(url.pathname);

  const sessionCookie = wantsChrome ? readCookie(context.request, SESSION_COOKIE) : null;
  if (sessionCookie !== null) {
    const session = await resolveSession(authPorts, sessionCookie);
    const principal = session === null ? null : await principalOf(session.principalId);
    if (principal !== null) {
      context.locals.viewer = {
        principalId: principal.id,
        username: principal.username,
        moderator: principal.platformRole === "moderator" || principal.platformRole === "admin",
      };
    }
  }

  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);

  /**
   * SPEC §50.2 — one deployment is readable, and the others say so on every response.
   *
   * `robots.txt` disallows the whole of a non-production deployment, and this is the half of
   * that statement which survives a crawler that never asked for the file. `apps/edge` sends
   * the same header on `api`, `mcp` and `media` for the same reason, and the argument is
   * written out there: the two mechanisms are honoured by different clients, and a URL that
   * reached an index through a link is the case the file cannot cover.
   *
   * `set` rather than `append`, so it overwrites the plain `noindex` a machine representation
   * or a feed already carries (§50.2). Both mean the same thing; the stricter one is the one
   * to keep, and two `X-Robots-Tag` headers saying nearly the same thing is how a directive
   * ends up being read as neither.
   *
   * Applied before the response reaches the edge cache below, so a cached copy carries it
   * too — the same ordering the security headers depend on.
   */
  if (!indexableDeployment) response.headers.set("x-robots-tag", "noindex, nofollow");

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
  if (
    context.request.headers.get("authorization") !== null ||
    context.request.headers.get("cookie") !== null
  ) {
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
