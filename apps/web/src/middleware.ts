import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "astro";

/**
 * SPEC §14.1, §50 — exactly one hostname serves the site; everything else redirects.
 *
 * A Cloudflare Redirect Rule could do this at the edge, and would be marginally cheaper.
 * It is done here instead because a rule configured in the dashboard is invisible to
 * version control and absent from anyone else's deployment (SPEC §82). Duplicate content
 * on a second hostname is precisely the risk §50.2 spends a section on, and it should not
 * depend on a setting nobody can see in the repository.
 */
export const onRequest: MiddlewareHandler = (context, next) => {
  const canonical = (env as { SITE_HOST?: string }).SITE_HOST;
  const url = new URL(context.request.url);

  // No canonical host configured (local dev), or already on it — nothing to do.
  if (!canonical || canonical === "localhost" || url.hostname === canonical) return next();

  url.hostname = canonical;
  url.port = "";
  return context.redirect(url.toString(), 301);
};
